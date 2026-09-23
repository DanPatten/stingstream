using Microsoft.Data.Sqlite;
using StingStream.Core.Data;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// A database made before `node_name` became `server_name` kept the old column, and every federated
/// and pin pass failed on "no such column: server_name". The rename has to happen once, keep the
/// rows, and do nothing on a database that already has the new name.
/// </summary>
public sealed class CoreDatabaseRenameTests
{
    [Fact]
    public void AnOldColumnIsRenamedAndKeepsItsRows()
    {
        using var c = new SqliteConnection("Data Source=:memory:");
        c.Open();
        CoreDatabase.Execute(c, "CREATE TABLE pins (item_key TEXT PRIMARY KEY, node_name TEXT NOT NULL DEFAULT '');");
        CoreDatabase.Execute(c, "INSERT INTO pins (item_key, node_name) VALUES ('tmdb:1', 'attic');");

        CoreDatabase.RenameColumnIfPresent(c, "pins", "node_name", "server_name");

        Assert.Equal(1, CoreDatabase.ScalarLong(c, "SELECT COUNT(*) FROM pins WHERE server_name = 'attic';"));
    }

    [Fact]
    public void ANewDatabaseIsLeftAloneAndRunningTwiceIsHarmless()
    {
        using var c = new SqliteConnection("Data Source=:memory:");
        c.Open();
        CoreDatabase.Execute(c, "CREATE TABLE federated (item_key TEXT PRIMARY KEY, server_name TEXT NOT NULL DEFAULT '');");

        CoreDatabase.RenameColumnIfPresent(c, "federated", "node_name", "server_name");
        CoreDatabase.RenameColumnIfPresent(c, "federated", "node_name", "server_name");

        Assert.Equal(1, CoreDatabase.ScalarLong(c, "SELECT COUNT(*) FROM pragma_table_info('federated') WHERE name = 'server_name';"));
    }
}
