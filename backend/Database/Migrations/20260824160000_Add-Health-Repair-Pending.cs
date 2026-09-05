using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using NzbWebDAV.Database;

#nullable disable

namespace NzbWebDAV.Database.Migrations;

/// <summary>
/// Tracks library files whose repair is waiting for the next repair schedule window.
/// Additive: existing rows default to false. Back up /config before upgrading.
/// </summary>
[DbContext(typeof(DavDatabaseContext))]
[Migration("20260824160000_Add-Health-Repair-Pending")]
public partial class AddHealthRepairPending : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.AddColumn<bool>(
            name: "HealthRepairPending",
            table: "DavItems",
            type: "INTEGER",
            nullable: false,
            defaultValue: false);

        migrationBuilder.CreateIndex(
            name: "IX_DavItems_HealthRepairPending_NextHealthCheck",
            table: "DavItems",
            columns: new[] { "HealthRepairPending", "NextHealthCheck" });
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropIndex(
            name: "IX_DavItems_HealthRepairPending_NextHealthCheck",
            table: "DavItems");

        migrationBuilder.DropColumn(
            name: "HealthRepairPending",
            table: "DavItems");
    }
}
