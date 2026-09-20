#nullable enable
using System.Collections.Concurrent;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.EntityFrameworkCore;

namespace BTCPayServer.Plugins.OpenReceive.Data;

/// <summary>
/// Persistence for minted invoices. The EF implementation is the runtime; the in-memory
/// one keeps the Lightning client testable without Postgres. Rows are written once and
/// never updated.
/// </summary>
public interface IInvoiceStore
{
    Task InsertAsync(OpenReceiveInvoice invoice, CancellationToken cancellationToken);
    Task<OpenReceiveInvoice?> FindAsync(string paymentHash, CancellationToken cancellationToken);
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
}

/// <summary>Test double; one instance shared by two connection states plays the database across a restart.</summary>
public sealed class InMemoryInvoiceStore : IInvoiceStore
{
    private readonly ConcurrentDictionary<string, OpenReceiveInvoice> _rows = new();

    public Task InsertAsync(OpenReceiveInvoice invoice, CancellationToken cancellationToken)
    {
        if (!_rows.TryAdd(invoice.PaymentHash, invoice)) throw new DbUpdateException($"invoice {invoice.PaymentHash} already exists");
        return Task.CompletedTask;
    }

    public Task<OpenReceiveInvoice?> FindAsync(string paymentHash, CancellationToken cancellationToken) =>
        Task.FromResult(_rows.TryGetValue(paymentHash, out var row) ? row : null);
}
