#nullable enable
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace BTCPayServer.Plugins.OpenReceive.Data.Migrations;

[DbContext(typeof(OpenReceivePluginDbContext))]
[Migration("20260921000001_RecoveryBindingAudit")]
public sealed class RecoveryBindingAudit : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder) =>
        migrationBuilder.Sql($"ALTER TABLE \"{OpenReceivePluginDbContext.Schema}\".openreceive_invoices ADD COLUMN recovery_binding_note text;");
}
