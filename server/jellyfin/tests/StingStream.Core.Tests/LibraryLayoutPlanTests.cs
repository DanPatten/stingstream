using System.Collections.Generic;
using System.IO;
using System.Linq;
using MediaBrowser.Model.Entities;
using StingStream.Core.Configuration;
using StingStream.Core.Data;
using StingStream.Core.Library;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// What the libraries should be, and what changing one actually does to it.
/// </summary>
/// <remarks>
/// <para>
/// Doing it needs a running media server and is only reachable from the end-to-end harnesses.
/// Deciding it is pure, and is where every invariant worth protecting lives, so it is pinned here.
/// </para>
/// <para>
/// Two of these tests exist because getting them wrong is silent.
/// <see cref="OnlyOneLibraryPerTypeCarriesTheFederatedTree"/> guards the merge that makes a peer's
/// copy of a series an extra version rather than a duplicate; <see cref="AFolderNobodyManagedIsNeverRemoved"/>
/// guards somebody else's hand edit against this node's idea of tidiness.
/// </para>
/// </remarks>
public class LibraryLayoutPlanTests
{
    private const string FederatedRoot = @"D:\data\federated";

    private static readonly PathsRuntime Runtime = new()
    {
        MediaMovies = @"D:\data\media\Movies",
        MediaTv = @"D:\data\media\TV",
        Federated = FederatedRoot,
    };

    /// <summary>A folder inside the federated tree, joined the way the plan itself joins it.</summary>
    /// <param name="leaf">The sub-folder.</param>
    /// <returns>The path.</returns>
    /// <remarks>
    /// Not a literal. <see cref="LibraryLayoutPlan"/> joins with <see cref="Path.Combine(string, string)"/>,
    /// which picks the separator of the platform it is running on, and these tests run on both: CI is
    /// Linux, where joining a Windows-shaped root gives <c>D:\data\federated/movies</c>. A hard-coded
    /// backslash was the worst of the two ways round to get this wrong, passing on the machine the
    /// test was written on and failing only once it reached CI.
    /// </remarks>
    private static string Federated(string leaf) => Path.Combine(FederatedRoot, leaf);

    private static SharedSettings Migrated()
    {
        var settings = new SharedSettings();
        LibraryMigration.Apply(settings);
        return settings;
    }

    [Fact]
    public void ABuiltInLibraryHoldsItsOwnFolderAndThePointerTree()
    {
        var plan = LibraryLayoutPlan.Plan(Migrated(), Runtime, FederatedRoot);

        var movies = plan.Single(p => p.Name == LibraryLayoutService.MoviesLibrary);
        Assert.Equal(CollectionTypeOptions.movies, movies.Type);
        Assert.Equal(
            new[] { @"D:\data\media\Movies", Federated("movies") },
            movies.Paths);
        Assert.True(movies.Unified);
    }

    [Fact]
    public void AnUnsetFolderFallsBackToTheSupervisorsPath()
    {
        // The migration deliberately leaves the folder empty, so the fallback is what makes a node
        // that has never been configured still have working libraries.
        var settings = Migrated();
        Assert.All(settings.Libraries, l => Assert.Empty(l.Paths));

        var plan = LibraryLayoutPlan.Plan(settings, Runtime, FederatedRoot);

        Assert.Contains(@"D:\data\media\TV", plan.Single(p => p.Name == LibraryLayoutService.TvLibrary).Paths);
    }

    [Fact]
    public void OnlyOneLibraryPerTypeCarriesTheFederatedTree()
    {
        // The whole reason a second drive is a second *folder* rather than a second library. Item
        // ids are derived from paths, so the same pointer reachable through two collection folders
        // is one item with two parents; and a series merges with a peer's copy only while both sit
        // in exactly one shared folder. Two libraries holding federated/movies does not duplicate
        // the merge, it breaks it.
        var settings = Migrated();
        settings.Libraries.Add(new LibrarySettings
        {
            Name = "Archive",
            FolderName = "Archive",
            Type = LibraryTypes.Movies,
            Paths = { @"E:\archive\films" },
        });

        var plan = LibraryLayoutPlan.Plan(settings, Runtime, FederatedRoot);

        var carrying = plan.Where(p => p.Paths.Any(x => x.Contains("federated", System.StringComparison.OrdinalIgnoreCase)
                                                        && x.EndsWith("movies", System.StringComparison.OrdinalIgnoreCase)))
            .ToList();
        Assert.Single(carrying);
        Assert.Equal(LibraryLayoutService.MoviesLibrary, carrying[0].Name);
        Assert.DoesNotContain(
            plan.Single(p => p.Name == "Archive").Paths,
            x => x.Contains("federated", System.StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void RecordingsFolderIsDerivedAndNeverConfigured()
    {
        // Peers' DVR recordings that no provider could identify. Its folder is not a setting, so
        // nothing a reader does can point it somewhere else; what they own is whether it runs at
        // all and whether it is hidden. A node with no rows yet still gets it.
        var plan = LibraryLayoutPlan.Plan(new SharedSettings(), Runtime, FederatedRoot);

        var recordings = plan.Single(p => p.Name == LibraryLayoutService.RecordingsLibrary);
        Assert.Equal(new[] { Federated("recordings") }, recordings.Paths);
        Assert.False(recordings.Unified);
    }

    [Fact]
    public void ASwitchedOffLibraryIsNotPlannedAtAll()
    {
        // Off is the owner saying "not on this server": no folder to reconcile, and further down
        // no manager running and no pointers written. The row stays, because it is what remembers
        // the folder for the day it goes back on.
        var settings = Migrated();
        settings.Libraries[0].Enabled = false;

        var plan = LibraryLayoutPlan.Plan(settings, Runtime, FederatedRoot);

        Assert.DoesNotContain(plan, p => p.Name == LibraryLayoutService.MoviesLibrary);
        Assert.Contains(plan, p => p.Name == LibraryLayoutService.TvLibrary);
    }

    [Fact]
    public void SwitchingRecordingsOffDropsIt()
    {
        var settings = Migrated();
        LibraryLayoutPlan.Recordings(settings)!.Enabled = false;

        var plan = LibraryLayoutPlan.Plan(settings, Runtime, FederatedRoot);

        Assert.DoesNotContain(plan, p => p.Name == LibraryLayoutService.RecordingsLibrary);
    }

    [Fact]
    public void TheFederatedTreeMovesToALibraryThatIsStillOn()
    {
        // The invariant at the top of this file: exactly one library per type carries the pointer
        // tree. Switching the built-in one off has to hand it to another library of that type
        // rather than strand it on a library this node no longer has.
        var settings = Migrated();
        settings.Libraries.Add(new LibrarySettings
        {
            Name = "Films on the NAS",
            FolderName = "Films on the NAS",
            Type = LibraryTypes.Movies,
            Paths = new List<string> { @"N:\Films" },
        });
        settings.Libraries[0].Enabled = false;

        var plan = LibraryLayoutPlan.Plan(settings, Runtime, FederatedRoot);

        var host = plan.Single(p => p.Name == "Films on the NAS");
        Assert.Contains(Federated("movies"), host.Paths);
    }

    [Fact]
    public void AHiddenLibraryIsStillPlannedInFull()
    {
        // Hiding is presentation. A hidden library still imports, still scans and still federates,
        // and someone will eventually try to "fix" that by skipping it here.
        var settings = Migrated();
        settings.Libraries[0].Hidden = true;

        var plan = LibraryLayoutPlan.Plan(settings, Runtime, FederatedRoot);

        Assert.Contains(Federated("movies"), plan.Single(p => p.Name == LibraryLayoutService.MoviesLibrary).Paths);
    }

    [Fact]
    public void ChangingAFolderAddsTheNewOneAndRemovesTheOld()
    {
        // The bug this whole change exists to fix: setting a path used to add it and leave the old
        // one behind forever, so the screen said one thing and the server did another.
        var (toAdd, toRemove) = LibraryLayoutPlan.Diff(
            currentLocations: new[] { @"D:\old\Movies", @"D:\data\federated\movies" },
            managedLocations: new[] { @"D:\old\Movies", @"D:\data\federated\movies" },
            desiredPaths: new[] { @"D:\new\Movies", @"D:\data\federated\movies" });

        Assert.Equal(new[] { @"D:\new\Movies" }, toAdd);
        Assert.Equal(new[] { @"D:\old\Movies" }, toRemove);
    }

    [Fact]
    public void AFolderNobodyManagedIsNeverRemoved()
    {
        // Somebody added a folder to the library through the media server's own interface. This
        // node did not put it there, so this node does not take it away -- otherwise "reconcile on
        // every start" would mean "silently revert anything you did outside StingStream".
        var (toAdd, toRemove) = LibraryLayoutPlan.Diff(
            currentLocations: new[] { @"D:\data\media\Movies", @"D:\somebody-elses\folder" },
            managedLocations: new[] { @"D:\data\media\Movies" },
            desiredPaths: new[] { @"D:\data\media\Movies" });

        Assert.Empty(toAdd);
        Assert.Empty(toRemove);
    }

    [Fact]
    public void NothingChangedMeansNothingToDo()
    {
        // Reconciliation runs on every boot now. This comparison is all that stands between that
        // and a library event storm on a node nobody has touched.
        var (toAdd, toRemove) = LibraryLayoutPlan.Diff(
            currentLocations: new[] { @"D:\data\media\Movies/" },
            managedLocations: new[] { @"D:\data\media\movies" },
            desiredPaths: new[] { @"D:\data\media\Movies" });

        Assert.Empty(toAdd);
        Assert.Empty(toRemove);
    }

    [Fact]
    public void ALibraryIsNeverStrippedOfEveryFolder()
    {
        // Not reachable by any user action, so if the arithmetic ever says so it is a bug -- and
        // leaving stale paths in place is far less damaging than detaching a library from
        // everything it holds.
        var (_, toRemove) = LibraryLayoutPlan.Diff(
            currentLocations: new[] { @"D:\data\media\Movies" },
            managedLocations: new[] { @"D:\data\media\Movies" },
            desiredPaths: new List<string>());

        Assert.Empty(toRemove);
    }
}
