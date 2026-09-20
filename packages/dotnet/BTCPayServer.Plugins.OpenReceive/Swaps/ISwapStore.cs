#nullable enable
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using BTCPayServer.Plugins.OpenReceive.Data;
using BTCPayServer.Plugins.OpenReceive.Generated;
using Microsoft.EntityFrameworkCore;

namespace BTCPayServer.Plugins.OpenReceive.Swaps;

/// <summary>
/// Persistence for swap rows. The EF implementation is the runtime; the in-memory one
/// keeps <see cref="SwapService"/> testable without Postgres. Both enforce the same two
/// invariants: one live order per invoice + asset (the partial unique index), and an
/// update only lands on the row version it loaded (<see cref="OpenReceiveSwap.Version"/>).
/// </summary>
public interface ISwapStore
{
    /// <summary>A cross-worker lock for one key (Postgres advisory lock at runtime).</summary>
    Task<IAsyncDisposable> LockAsync(string key, CancellationToken cancellationToken);
    Task<OpenReceiveSwap?> GetAsync(string id, CancellationToken cancellationToken);
    Task<OpenReceiveSwap?> FindLiveAsync(string invoiceId, string payInAsset, CancellationToken cancellationToken);
    Task<IReadOnlyList<OpenReceiveSwap>> ForInvoiceAsync(string invoiceId, CancellationToken cancellationToken);
    Task<IReadOnlyList<OpenReceiveSwap>> RecoveryForInvoiceAsync(string invoiceId, string? after, int limit, CancellationToken cancellationToken);
    Task<IReadOnlyList<OpenReceiveSwap>> ForStoreAsync(string storeId, int limit, CancellationToken cancellationToken);
    /// <summary>Rows due for a provider refresh at <paramref name="now"/> (<see cref="SwapService.IsDue"/>), least recently polled first.</summary>
    Task<IReadOnlyList<OpenReceiveSwap>> DueAsync(long now, int limit, CancellationToken cancellationToken);
    Task<int> CountAttentionAsync(string storeId, CancellationToken cancellationToken);
    Task InsertAsync(OpenReceiveSwap swap, CancellationToken cancellationToken);
    Task<OpenReceiveSwap?> FindProviderOrderAsync(string provider, string orderId, CancellationToken cancellationToken);
    /// <summary>One transaction: retire the exact old version and insert the replacement.</summary>
    Task ReplaceAsync(OpenReceiveSwap previous, OpenReceiveSwap replacement, long now, CancellationToken cancellationToken);
    Task<OpenReceiveSwap?> ClaimPollAsync(string id, long now, string owner, int leaseSeconds, CancellationToken cancellationToken);
    Task ReleasePollAsync(string id, string owner, CancellationToken cancellationToken);
    /// <summary>Writes the row; throws <see cref="SwapConcurrencyException"/> when the stored row is no longer the version this copy loaded.</summary>
    Task UpdateAsync(OpenReceiveSwap swap, CancellationToken cancellationToken);
}

/// <summary>An update lost the race: the row changed since this copy was loaded. Reload and decide again.</summary>
public sealed class SwapConcurrencyException : Exception
{
    public SwapConcurrencyException(string swapId, Exception? inner = null)
        : base($"swap {swapId} changed since it was loaded", inner)
    {
    }
}

public static class SwapStates
{
    public static bool IsTerminal(string state) => OpenReceiveTables.SwapStates.TryGetValue(state, out var info) && info.Terminal;
    public static readonly IReadOnlyList<string> TerminalStates = OpenReceiveTables.SwapStates.Values.Where(s => s.Terminal).Select(s => s.State).ToArray();
}

public sealed class EfSwapStore : ISwapStore
{
    private readonly OpenReceiveDbContextFactory _factory;

    public EfSwapStore(OpenReceiveDbContextFactory factory)
    {
        _factory = factory;
    }

    public async Task<IAsyncDisposable> LockAsync(string key, CancellationToken cancellationToken)
    {
        var context = _factory.CreateContext(o => o.ExecutionStrategy(d => new Microsoft.EntityFrameworkCore.Storage.NonRetryingExecutionStrategy(d)));
        var transaction = await context.Database.BeginTransactionAsync(cancellationToken);
        await context.Database.ExecuteSqlAsync($"SELECT pg_advisory_xact_lock(hashtext({key}))", cancellationToken);
        return new AdvisoryLock(context, transaction);
    }

    private sealed class AdvisoryLock : IAsyncDisposable
    {
        private readonly OpenReceivePluginDbContext _context;
        private readonly Microsoft.EntityFrameworkCore.Storage.IDbContextTransaction _transaction;
        public AdvisoryLock(OpenReceivePluginDbContext context, Microsoft.EntityFrameworkCore.Storage.IDbContextTransaction transaction)
        {
            _context = context;
            _transaction = transaction;
        }
        public async ValueTask DisposeAsync()
        {
            await _transaction.CommitAsync();
            await _transaction.DisposeAsync();
            await _context.DisposeAsync();
        }
    }

    public async Task<OpenReceiveSwap?> GetAsync(string id, CancellationToken cancellationToken)
    {
        await using var context = _factory.CreateContext();
        return await context.Swaps.AsNoTracking().FirstOrDefaultAsync(s => s.Id == id, cancellationToken);
    }

    public async Task<OpenReceiveSwap?> FindLiveAsync(string invoiceId, string payInAsset, CancellationToken cancellationToken)
    {
        await using var context = _factory.CreateContext();
        var terminal = SwapStates.TerminalStates;
        return await context.Swaps.AsNoTracking()
            .Where(s => s.InvoiceId == invoiceId && s.PayInAsset == payInAsset && s.RetiredAt == null && !terminal.Contains(s.State))
            .OrderByDescending(s => s.CreatedAt)
            .FirstOrDefaultAsync(cancellationToken);
    }

    public async Task<IReadOnlyList<OpenReceiveSwap>> ForInvoiceAsync(string invoiceId, CancellationToken cancellationToken)
    {
        await using var context = _factory.CreateContext();
        return await context.Swaps.AsNoTracking().Where(s => s.InvoiceId == invoiceId).OrderByDescending(s => s.CreatedAt).ToListAsync(cancellationToken);
    }

    public async Task<IReadOnlyList<OpenReceiveSwap>> RecoveryForInvoiceAsync(string invoiceId, string? after, int limit, CancellationToken cancellationToken)
    {
        await using var context = _factory.CreateContext();
        return await context.Swaps.AsNoTracking().Where(s => s.InvoiceId == invoiceId && (after == null || s.Id.CompareTo(after) > 0))
            .OrderBy(s => s.Id).Take(limit).ToListAsync(cancellationToken);
    }

    public async Task<IReadOnlyList<OpenReceiveSwap>> ForStoreAsync(string storeId, int limit, CancellationToken cancellationToken)
    {
        await using var context = _factory.CreateContext();
        return await context.Swaps.AsNoTracking().Where(s => s.StoreId == storeId).OrderByDescending(s => s.CreatedAt).Take(limit).ToListAsync(cancellationToken);
    }

    public async Task<IReadOnlyList<OpenReceiveSwap>> DueAsync(long now, int limit, CancellationToken cancellationToken)
    {
        await using var context = _factory.CreateContext();
        var terminal = SwapStates.TerminalStates;
        var pendingBefore = now - SwapService.PollSeconds;
        var settledBefore = now - SwapService.SettledPollSeconds;
        // SwapService.IsDue in SQL: live, not a completed order whose Lightning side settled,
        // and past its cadence — so a backlog never pins the poller to the same 200 rows.
        return await context.Swaps.AsNoTracking()
            .Where(s => s.RecoveryRefreshRequired || !terminal.Contains(s.State))
            .Where(s => s.RecoveryRefreshRequired || s.State != "completed" || s.WalletSettledAt == null)
            .Where(s => (s.PollLeaseUntil == null || s.PollLeaseUntil <= now) && (s.NextPollAt == null || s.NextPollAt <= now))
            .Where(s => s.RecoveryRefreshRequired || s.LastPolledAt == null
                        || (s.WalletSettledAt == null && s.LastPolledAt <= pendingBefore)
                        || (s.WalletSettledAt != null && s.LastPolledAt <= settledBefore))
            .OrderBy(s => s.LastPolledAt ?? 0).ThenBy(s => s.Id).Take(limit).ToListAsync(cancellationToken);
    }

    public async Task<int> CountAttentionAsync(string storeId, CancellationToken cancellationToken)
    {
        await using var context = _factory.CreateContext();
        return await context.Swaps.CountAsync(s => s.StoreId == storeId && s.Attention, cancellationToken);
    }

    public async Task InsertAsync(OpenReceiveSwap swap, CancellationToken cancellationToken)
    {
        await using var context = _factory.CreateContext();
        context.Swaps.Add(swap);
        await context.SaveChangesAsync(cancellationToken);
    }

    public async Task<OpenReceiveSwap?> FindProviderOrderAsync(string provider, string orderId, CancellationToken cancellationToken)
    {
        await using var context = _factory.CreateContext();
        return await context.Swaps.AsNoTracking().SingleOrDefaultAsync(s => s.Provider == provider && s.ProviderOrderId == orderId, cancellationToken);
    }

    public async Task ReplaceAsync(OpenReceiveSwap previous, OpenReceiveSwap replacement, long now, CancellationToken cancellationToken)
    {
        await using var context = _factory.CreateContext(o => o.ExecutionStrategy(d => new Microsoft.EntityFrameworkCore.Storage.NonRetryingExecutionStrategy(d)));
        await using var transaction = await context.Database.BeginTransactionAsync(cancellationToken);
        previous.RetiredAt = now;
        previous.ReplacementId = replacement.Id;
        context.Swaps.Update(previous);
        try
        {
            // Free the offered-attempt slot inside the transaction before the insert.
            await context.SaveChangesAsync(cancellationToken);
            context.Swaps.Add(replacement);
            await context.SaveChangesAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
        }
        catch (DbUpdateConcurrencyException e) { throw new SwapConcurrencyException(previous.Id, e); }
    }

    public async Task<OpenReceiveSwap?> ClaimPollAsync(string id, long now, string owner, int leaseSeconds, CancellationToken cancellationToken)
    {
        await using var context = _factory.CreateContext();
        var changed = await context.Swaps.Where(s => s.Id == id && (s.PollLeaseUntil == null || s.PollLeaseUntil <= now)
                && (s.NextPollAt == null || s.NextPollAt <= now))
            .ExecuteUpdateAsync(set => set.SetProperty(s => s.PollLeaseUntil, now + leaseSeconds).SetProperty(s => s.PollLeaseOwner, owner), cancellationToken);
        return changed == 0 ? null : await context.Swaps.AsNoTracking().SingleAsync(s => s.Id == id, cancellationToken);
    }

    public async Task ReleasePollAsync(string id, string owner, CancellationToken cancellationToken)
    {
        await using var context = _factory.CreateContext();
        await context.Swaps.Where(s => s.Id == id && s.PollLeaseOwner == owner)
            .ExecuteUpdateAsync(set => set.SetProperty(s => s.PollLeaseUntil, (long?)null).SetProperty(s => s.PollLeaseOwner, (string?)null), cancellationToken);
    }

    public async Task UpdateAsync(OpenReceiveSwap swap, CancellationToken cancellationToken)
    {
        await using var context = _factory.CreateContext();
        context.Swaps.Update(swap);
        try
        {
            await context.SaveChangesAsync(cancellationToken);
        }
        catch (DbUpdateConcurrencyException e)
        {
            throw new SwapConcurrencyException(swap.Id, e);
        }
    }
}

/// <summary>Test double with the same one-live-order and same-version-only rules.</summary>
public sealed class InMemorySwapStore : ISwapStore
{
    private readonly ConcurrentDictionary<string, OpenReceiveSwap> _rows = new();
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _locks = new();
    private readonly object _write = new();

    public IReadOnlyCollection<OpenReceiveSwap> Rows => _rows.Values.ToArray();

    public async Task<IAsyncDisposable> LockAsync(string key, CancellationToken cancellationToken)
    {
        var gate = _locks.GetOrAdd(key, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(cancellationToken);
        return new Release(gate);
    }

    private sealed class Release : IAsyncDisposable
    {
        private readonly SemaphoreSlim _gate;
        public Release(SemaphoreSlim gate) => _gate = gate;
        public ValueTask DisposeAsync() { _gate.Release(); return ValueTask.CompletedTask; }
    }

    public Task<OpenReceiveSwap?> GetAsync(string id, CancellationToken cancellationToken) =>
        Task.FromResult(_rows.TryGetValue(id, out var row) ? Clone(row) : null);

    public Task<OpenReceiveSwap?> FindLiveAsync(string invoiceId, string payInAsset, CancellationToken cancellationToken) =>
        Task.FromResult(_rows.Values.Where(r => r.InvoiceId == invoiceId && r.PayInAsset == payInAsset && r.RetiredAt is null && !r.IsTerminal)
            .OrderByDescending(r => r.CreatedAt).Select(Clone).FirstOrDefault());

    public Task<IReadOnlyList<OpenReceiveSwap>> ForInvoiceAsync(string invoiceId, CancellationToken cancellationToken) =>
        Task.FromResult<IReadOnlyList<OpenReceiveSwap>>(_rows.Values.Where(r => r.InvoiceId == invoiceId).OrderByDescending(r => r.CreatedAt).Select(Clone).ToList());

    public Task<IReadOnlyList<OpenReceiveSwap>> RecoveryForInvoiceAsync(string invoiceId, string? after, int limit, CancellationToken cancellationToken) =>
        Task.FromResult<IReadOnlyList<OpenReceiveSwap>>(_rows.Values.Where(r => r.InvoiceId == invoiceId && (after is null || string.CompareOrdinal(r.Id, after) > 0))
            .OrderBy(r => r.Id).Take(limit).Select(Clone).ToArray());

    public Task<IReadOnlyList<OpenReceiveSwap>> ForStoreAsync(string storeId, int limit, CancellationToken cancellationToken) =>
        Task.FromResult<IReadOnlyList<OpenReceiveSwap>>(_rows.Values.Where(r => r.StoreId == storeId).OrderByDescending(r => r.CreatedAt).Take(limit).Select(Clone).ToList());

    public Task<IReadOnlyList<OpenReceiveSwap>> DueAsync(long now, int limit, CancellationToken cancellationToken) =>
        Task.FromResult<IReadOnlyList<OpenReceiveSwap>>(_rows.Values.Where(r => SwapService.IsDue(r, now)).OrderBy(r => r.LastPolledAt ?? 0).ThenBy(r => r.Id).Take(limit).Select(Clone).ToList());

    public Task<int> CountAttentionAsync(string storeId, CancellationToken cancellationToken) =>
        Task.FromResult(_rows.Values.Count(r => r.StoreId == storeId && r.Attention));

    public Task InsertAsync(OpenReceiveSwap swap, CancellationToken cancellationToken)
    {
        lock (_write)
        {
            if (swap.RetiredAt is null && !swap.IsTerminal && _rows.Values.Any(r => r.InvoiceId == swap.InvoiceId && r.PayInAsset == swap.PayInAsset && r.RetiredAt is null && !r.IsTerminal))
            {
                throw new InvalidOperationException("duplicate live swap for invoice + asset (unique index)");
            }
            if (_rows.Values.Any(r => r.Provider == swap.Provider && r.ProviderOrderId == swap.ProviderOrderId))
            {
                throw new InvalidOperationException("duplicate provider order (unique index)");
            }
            swap.Version = 1;
            _rows[swap.Id] = Clone(swap);
        }
        return Task.CompletedTask;
    }

    public Task<OpenReceiveSwap?> FindProviderOrderAsync(string provider, string orderId, CancellationToken cancellationToken) =>
        Task.FromResult(_rows.Values.Where(r => r.Provider == provider && r.ProviderOrderId == orderId).Select(Clone).SingleOrDefault());

    public Task ReplaceAsync(OpenReceiveSwap previous, OpenReceiveSwap replacement, long now, CancellationToken cancellationToken)
    {
        lock (_write)
        {
            if (!_rows.TryGetValue(previous.Id, out var stored) || stored.Version != previous.Version) throw new SwapConcurrencyException(previous.Id);
            // Validate before any mutation, as a transaction would.
            if (_rows.Values.Any(r => r.Provider == replacement.Provider && r.ProviderOrderId == replacement.ProviderOrderId)) throw new InvalidOperationException("duplicate provider order");
            previous.RetiredAt = now;
            previous.ReplacementId = replacement.Id;
            previous.Version++;
            replacement.Version = 1;
            _rows[previous.Id] = Clone(previous);
            _rows[replacement.Id] = Clone(replacement);
        }
        return Task.CompletedTask;
    }

    public Task<OpenReceiveSwap?> ClaimPollAsync(string id, long now, string owner, int leaseSeconds, CancellationToken cancellationToken)
    {
        lock (_write)
        {
            if (!_rows.TryGetValue(id, out var row) || !SwapService.IsDue(row, now)) return Task.FromResult<OpenReceiveSwap?>(null);
            row.PollLeaseUntil = now + leaseSeconds;
            row.PollLeaseOwner = owner;
            row.Version++;
            return Task.FromResult<OpenReceiveSwap?>(Clone(row));
        }
    }

    public Task ReleasePollAsync(string id, string owner, CancellationToken cancellationToken)
    {
        lock (_write)
        {
            if (_rows.TryGetValue(id, out var row) && row.PollLeaseOwner == owner)
            {
                row.PollLeaseUntil = null;
                row.PollLeaseOwner = null;
                row.Version++;
            }
        }
        return Task.CompletedTask;
    }

    public Task UpdateAsync(OpenReceiveSwap swap, CancellationToken cancellationToken)
    {
        lock (_write)
        {
            // The optimistic rule Postgres enforces through xmin: a stale copy never overwrites a newer row.
            if (!_rows.TryGetValue(swap.Id, out var stored) || stored.Version != swap.Version)
            {
                throw new SwapConcurrencyException(swap.Id);
            }
            swap.Version++;
            _rows[swap.Id] = Clone(swap);
        }
        return Task.CompletedTask;
    }

    private static OpenReceiveSwap Clone(OpenReceiveSwap row) => (OpenReceiveSwap)row.MemberwiseCloneShim();
}

internal static class SwapCloneExtensions
{
    public static object MemberwiseCloneShim(this OpenReceiveSwap row)
    {
        var copy = new OpenReceiveSwap();
        foreach (var property in typeof(OpenReceiveSwap).GetProperties().Where(p => p.CanWrite))
        {
            property.SetValue(copy, property.GetValue(row));
        }
        return copy;
    }
}
