#nullable enable
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.EntityFrameworkCore;

namespace BTCPayServer.Plugins.OpenReceive.Data;

/// <summary>
/// Persistence for minted invoices. The EF implementation is the runtime; the in-memory
/// one keeps the Lightning client testable without Postgres. Mint metadata is immutable;
/// recovery scheduling and acknowledgment checkpoints use optimistic concurrency.
/// </summary>
public interface IInvoiceStore
{
    Task InsertAsync(OpenReceiveInvoice invoice, CancellationToken cancellationToken);
    Task<OpenReceiveInvoice?> FindAsync(string paymentHash, CancellationToken cancellationToken);
    Task<IReadOnlyList<OpenReceiveInvoice>> RecoveryDueAsync(long now, int limit, CancellationToken cancellationToken);
    Task UpdateAsync(OpenReceiveInvoice invoice, CancellationToken cancellationToken);
}

public sealed class EfInvoiceStore : IInvoiceStore
{
    private readonly OpenReceiveDbContextFactory _factory;

    public EfInvoiceStore(OpenReceiveDbContextFactory factory)
    {
        _factory = factory;
    }

    public async Task InsertAsync(OpenReceiveInvoice invoice, CancellationToken cancellationToken)
    {
        await using var context = _factory.CreateContext();
        context.Invoices.Add(invoice);
        await context.SaveChangesAsync(cancellationToken);
    }

    public async Task<OpenReceiveInvoice?> FindAsync(string paymentHash, CancellationToken cancellationToken)
    {
        await using var context = _factory.CreateContext();
        return await context.Invoices.AsNoTracking().FirstOrDefaultAsync(i => i.PaymentHash == paymentHash, cancellationToken);
    }
    public async Task<IReadOnlyList<OpenReceiveInvoice>> RecoveryDueAsync(long now, int limit, CancellationToken cancellationToken)
    {
        await using var context = _factory.CreateContext();
        // Ordered keyset: advancing each selected row's due time rotates unresolved mappings fairly.
        return await context.Invoices.AsNoTracking().Where(i => i.RecoveryClosedAt == null && i.NextRecoveryAt <= now)
            .OrderBy(i => i.NextRecoveryAt).ThenBy(i => i.PaymentHash).Take(Math.Clamp(limit, 1, 200)).ToListAsync(cancellationToken);
    }

    public async Task UpdateAsync(OpenReceiveInvoice invoice, CancellationToken cancellationToken)
    {
        await using var context = _factory.CreateContext();
        context.Invoices.Update(invoice);
        await context.SaveChangesAsync(cancellationToken);
    }

}

/// <summary>Test double; one instance shared by two connection states plays the database across a restart.</summary>
public sealed class InMemoryInvoiceStore : IInvoiceStore
{
    private readonly ConcurrentDictionary<string, OpenReceiveInvoice> _rows = new();

    public Task InsertAsync(OpenReceiveInvoice invoice, CancellationToken cancellationToken)
    {
        invoice.Version = 1;
        if (!_rows.TryAdd(invoice.PaymentHash, Clone(invoice))) throw new DbUpdateException($"invoice {invoice.PaymentHash} already exists");
        return Task.CompletedTask;
    }

    public Task<OpenReceiveInvoice?> FindAsync(string paymentHash, CancellationToken cancellationToken) =>
        Task.FromResult(_rows.TryGetValue(paymentHash, out var row) ? Clone(row) : null);
    public Task<IReadOnlyList<OpenReceiveInvoice>> RecoveryDueAsync(long now, int limit, CancellationToken cancellationToken) =>
        Task.FromResult<IReadOnlyList<OpenReceiveInvoice>>(_rows.Values.Where(i => i.RecoveryClosedAt is null && i.NextRecoveryAt <= now)
            .OrderBy(i => i.NextRecoveryAt).ThenBy(i => i.PaymentHash).Take(Math.Clamp(limit, 1, 200)).Select(Clone).ToArray());

    public Task UpdateAsync(OpenReceiveInvoice invoice, CancellationToken cancellationToken)
    {
        lock (_rows)
        {
            if (!_rows.TryGetValue(invoice.PaymentHash, out var previous) || previous.Version != invoice.Version) throw new DbUpdateConcurrencyException();
            invoice.Version++;
            _rows[invoice.PaymentHash] = Clone(invoice);
        }
        return Task.CompletedTask;
    }

    private static OpenReceiveInvoice Clone(OpenReceiveInvoice row)
    {
        var copy = new OpenReceiveInvoice();
        foreach (var property in typeof(OpenReceiveInvoice).GetProperties().Where(p => p.CanWrite)) property.SetValue(copy, property.GetValue(row));
        return copy;
    }

}
