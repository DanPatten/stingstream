using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace NzbWebDAV.Database.MetricsMigrations
{
    /// <inheritdoc />
    public partial class AddMissesCounters : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<long>(
                name: "Misses",
                table: "ThroughputMinutes",
                type: "INTEGER",
                nullable: false,
                defaultValue: 0L);

            migrationBuilder.AddColumn<long>(
                name: "Misses",
                table: "ProviderMinutes",
                type: "INTEGER",
                nullable: false,
                defaultValue: 0L);

            migrationBuilder.AddColumn<long>(
                name: "Misses",
                table: "ProviderHourly",
                type: "INTEGER",
                nullable: false,
                defaultValue: 0L);

            // Prior Errors counted Missing as failures. Existing rollups cannot split
            // those values accurately without scanning the large raw SegmentFetches
            // table, which can make startup migrations effectively unbounded. Treat
            // historical Errors as Misses; new rollups track the two counters exactly.
            migrationBuilder.Sql(
                "UPDATE ThroughputMinutes SET Misses = Errors, Errors = 0;");
            migrationBuilder.Sql(
                "UPDATE ProviderMinutes SET Misses = Errors, Errors = 0;");
            migrationBuilder.Sql(
                "UPDATE ProviderHourly SET Misses = Errors, Errors = 0;");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // Fold Misses back into Errors so totals stay roughly comparable.
            migrationBuilder.Sql(
                "UPDATE ThroughputMinutes SET Errors = Errors + Misses;");
            migrationBuilder.Sql(
                "UPDATE ProviderMinutes SET Errors = Errors + Misses;");
            migrationBuilder.Sql(
                "UPDATE ProviderHourly SET Errors = Errors + Misses;");

            migrationBuilder.DropColumn(
                name: "Misses",
                table: "ThroughputMinutes");

            migrationBuilder.DropColumn(
                name: "Misses",
                table: "ProviderMinutes");

            migrationBuilder.DropColumn(
                name: "Misses",
                table: "ProviderHourly");
        }
    }
}
