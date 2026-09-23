using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging.Abstractions;
using StingStream.Core.Arr;
using StingStream.Core.Configuration;
using StingStream.Core.Data;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// Quality profiles stored by StingStream and copied into the managers by the sync.
/// </summary>
/// <remarks>
/// Runs against a real <c>core.db</c> and a fake manager over HTTP rather than mocks, so what is
/// judged is what the store holds and the requests the service actually sends.
/// </remarks>
public class QualityProfileStoreTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    // --- with no manager at all ----------------------------------------------------------------

    [Fact]
    public async Task A_node_with_no_manager_lists_the_built_ins_at_once()
    {
        using var node = new TempNode();

        var list = await node.Service.ListAsync(Array.Empty<ArrClient>(), Ct);

        Assert.Equal(new[] { "Any", "High", "Medium", "Low" }, list.Select(p => p.Name));
        Assert.All(list, p => Assert.True(p.IsBuiltIn));
        Assert.True(list.Single(p => p.Name == "Medium").IsDefault);
        Assert.Equal(new[] { "720p", "1080p" }, list.Single(p => p.Name == "Medium").Tiers);
        Assert.Equal("Medium", node.Settings.Get().DefaultQualityProfileName);
    }

    [Fact]
    public async Task Profiles_are_created_edited_reset_and_deleted_with_no_manager_running()
    {
        using var node = new TempNode();
        var service = node.Service;

        var created = await service.SaveAsync(Profile("Mine", "2160p"), mustExist: false, Ct);
        Assert.True(created.Ok);

        var edited = await service.SaveAsync(Profile("High", "sd", "720p"), mustExist: true, Ct);
        Assert.True(edited.Ok);
        Assert.Equal(new[] { "sd", "720p" }, service.Find("High")!.Tiers);
        Assert.Equal("720p", service.Find("High")!.CutoffTier);

        var reset = await service.ResetAsync("High", Ct);
        Assert.True(reset.Ok);
        Assert.Equal(new[] { "1080p", "2160p" }, service.Find("High")!.Tiers);

        await node.Settings.UpdateAsync(s => s.DefaultQualityProfileName = "Mine", Ct);
        var deleted = await service.DeleteAsync("Mine", Array.Empty<ArrClient>(), Ct);
        Assert.True(deleted.Ok);

        var settings = node.Settings.Get();
        Assert.Null(service.Find("Mine"));
        Assert.Contains(settings.RetiredProviders, r => r.Resource == "qualityprofile" && r.Name == "Mine");
        Assert.Equal("Medium", settings.DefaultQualityProfileName);
    }

    [Fact]
    public async Task An_update_to_a_profile_that_does_not_exist_is_not_found()
    {
        using var node = new TempNode();

        var result = await node.Service.SaveAsync(Profile("Nope", "720p"), mustExist: true, Ct);

        Assert.False(result.Ok);
        Assert.True(result.NotFound);
    }

    [Fact]
    public async Task A_built_in_cannot_be_deleted()
    {
        using var node = new TempNode();

        var result = await node.Service.DeleteAsync("Low", Array.Empty<ArrClient>(), Ct);

        Assert.False(result.Ok);
        Assert.NotNull(node.Service.Find("Low"));
    }

    [Fact]
    public async Task Recreating_a_deleted_name_takes_it_off_the_retired_list()
    {
        using var node = new TempNode();
        await node.Service.SaveAsync(Profile("Mine", "720p"), mustExist: false, Ct);
        await node.Service.DeleteAsync("Mine", Array.Empty<ArrClient>(), Ct);

        await node.Service.SaveAsync(Profile("Mine", "1080p"), mustExist: false, Ct);

        Assert.DoesNotContain(node.Settings.Get().RetiredProviders, r => r.Name == "Mine");
    }

    [Fact]
    public void A_cutoff_outside_the_tiers_becomes_the_best_tier()
    {
        var stored = QualityProfileService.ToSettings(new QualityProfileView
        {
            Name = "x",
            Tiers = new List<string> { "2160p", "sd" },
            CutoffTier = "720p",
        });

        Assert.Equal(new[] { "sd", "2160p" }, stored.Tiers);
        Assert.Equal("2160p", stored.CutoffTier);
    }

    [Fact]
    public void A_whole_settings_save_keeps_the_stored_profiles()
    {
        var stored = new SharedSettings();
        stored.QualityProfiles.Add(new QualityProfileSettings { Name = "Mine", Tiers = new() { "720p" } });

        var incoming = SharedSettings.PreserveServerOwned(new SharedSettings(), stored);

        Assert.Equal("Mine", Assert.Single(incoming.QualityProfiles).Name);
    }

    // --- the sync ------------------------------------------------------------------------------

    [Fact]
    public async Task First_contact_leaves_the_stored_profiles_and_anything_still_in_use()
    {
        using var node = new TempNode();
        var arr = new FakeArr("Any", "SD", "HD-1080p");
        arr.Movies.Add(Movie(1, arr.IdOf("HD-1080p")));

        await node.Service.SyncAsync(arr.Client, new SyncStatus(), Ct);

        Assert.Equal(
            new[] { "Any", "HD-1080p", "High", "Low", "Medium" },
            arr.Names.OrderBy(n => n, StringComparer.Ordinal));

        // Kept because a title uses it, so it has to be in the list or it could never be deleted.
        Assert.NotNull(node.Service.Find("HD-1080p"));
        Assert.Null(node.Service.Find("SD"));
    }

    [Fact]
    public async Task First_contact_rewrites_the_stock_profile_that_shares_a_built_in_name()
    {
        // Both managers ship an "Any" that takes remuxes. Keeping it because the name matched would
        // leave the one profile called Any doing something the built-in never does.
        using var node = new TempNode();
        var arr = new FakeArr("Any");
        foreach (var item in arr.Profiles[0]["items"]!.AsArray().OfType<JsonObject>())
        {
            item["allowed"] = true;
        }

        await node.Service.SyncAsync(arr.Client, new SyncStatus(), Ct);

        var any = arr.Profile("Any");
        Assert.False(Allowed(any, "Remux-1080p"));
        Assert.True(Allowed(any, "SDTV"));
        Assert.True(Allowed(any, "Bluray-2160p"));
    }

    [Fact]
    public async Task Medium_is_written_with_its_tiers_and_cutoff()
    {
        using var node = new TempNode();
        var arr = new FakeArr();

        await node.Service.SyncAsync(arr.Client, new SyncStatus(), Ct);

        var medium = arr.Profile("Medium");
        Assert.True(Allowed(medium, "HDTV-720p"));
        Assert.True(Allowed(medium, "Bluray-1080p"));
        Assert.False(Allowed(medium, "SDTV"));
        Assert.False(Allowed(medium, "Bluray-2160p"));
        Assert.Equal(7, medium["cutoff"]!.GetValue<int>());
        Assert.True(medium["upgradeAllowed"]!.GetValue<bool>());
    }

    [Fact]
    public async Task A_second_sync_with_nothing_changed_writes_nothing()
    {
        using var node = new TempNode();
        var arr = new FakeArr();
        await node.Service.SyncAsync(arr.Client, new SyncStatus(), Ct);
        arr.Writes = 0;

        await node.Service.SyncAsync(arr.Client, new SyncStatus(), Ct);

        Assert.Equal(0, arr.Writes);
    }

    [Fact]
    public async Task A_profile_made_while_the_manager_was_down_reaches_it_on_the_next_sync()
    {
        using var node = new TempNode();
        var arr = new FakeArr();
        await node.Service.SyncAsync(arr.Client, new SyncStatus(), Ct);

        await node.Service.SaveAsync(Profile("Mine", "2160p"), mustExist: false, Ct);
        await node.Service.SaveAsync(Profile("Low", "sd"), mustExist: true, Ct);
        await node.Service.SyncAsync(arr.Client, new SyncStatus(), Ct);

        Assert.True(Allowed(arr.Profile("Mine"), "Bluray-2160p"));
        Assert.False(Allowed(arr.Profile("Low"), "HDTV-720p"));
    }

    [Fact]
    public async Task A_manager_seeded_before_the_store_is_copied_in_and_not_overwritten()
    {
        // A node upgraded in place: its manager was seeded long ago, somebody narrowed High to
        // 4K inside it and made "WebOnly" of a single quality, and the store has never been read.
        using var node = new TempNode();
        await node.Settings.PutDocumentAsync(
            QualityProfileSeedMarker.StorageKey,
            new QualityProfileSeedMarker { Apps = { "radarr" } },
            Ct);
        var arr = new FakeArr("Any", "High", "Medium", "Low", "WebOnly");
        arr.Allow("High", "Bluray-2160p", cutoff: 19);
        arr.Allow("WebOnly", "HDTV-1080p", cutoff: 9);
        var before = arr.Profile("High").ToJsonString();

        // The store is first read with the manager down, so it starts from the built-ins.
        await node.Service.ListAsync(Array.Empty<ArrClient>(), Ct);
        await node.Service.SyncAsync(arr.Client, new SyncStatus(), Ct);

        Assert.Equal(new[] { "2160p" }, node.Service.Find("High")!.Tiers);
        Assert.Equal(new[] { "1080p" }, node.Service.Find("WebOnly")!.Tiers);
        Assert.Equal(before, arr.Profile("High").ToJsonString());
        Assert.False(Allowed(arr.Profile("WebOnly"), "Bluray-1080p"));
        Assert.Contains("radarr", node.Settings.GetDocument<QualityProfileSeedMarker>(QualityProfileSeedMarker.StorageKey)!.Adopted);
    }

    [Fact]
    public async Task An_edit_made_before_the_manager_was_read_wins_over_its_copy()
    {
        using var node = new TempNode();
        await node.Settings.PutDocumentAsync(
            QualityProfileSeedMarker.StorageKey,
            new QualityProfileSeedMarker { Apps = { "radarr" } },
            Ct);
        var arr = new FakeArr("Any", "High", "Medium", "Low");
        arr.Allow("Low", "SDTV", cutoff: 1);

        await node.Service.SaveAsync(Profile("Low", "720p"), mustExist: true, Ct);
        await node.Service.SyncAsync(arr.Client, new SyncStatus(), Ct);

        Assert.Equal(new[] { "720p" }, node.Service.Find("Low")!.Tiers);
        Assert.True(Allowed(arr.Profile("Low"), "HDTV-720p"));
        Assert.False(Allowed(arr.Profile("Low"), "SDTV"));
    }

    [Fact]
    public async Task The_list_says_which_running_manager_holds_each_profile()
    {
        using var node = new TempNode();
        var arr = new FakeArr();
        await node.Service.SyncAsync(arr.Client, new SyncStatus(), Ct);
        await node.Service.SaveAsync(Profile("Mine", "720p"), mustExist: false, Ct);

        var list = await node.Service.ListAsync(new[] { arr.Client }, Ct);

        var medium = list.Single(p => p.Name == "Medium");
        Assert.Equal(new[] { "radarr" }, medium.Apps);
        Assert.Equal(arr.IdOf("Medium"), medium.Ids["radarr"]);
        Assert.True(medium.InSync);
        Assert.False(list.Single(p => p.Name == "Mine").InSync);
    }

    [Fact]
    public async Task The_list_does_not_wait_for_a_manager_that_does_not_answer()
    {
        using var node = new TempNode();
        var arr = new FakeArr { Hang = true };

        var watch = System.Diagnostics.Stopwatch.StartNew();
        var list = await node.Service.ListAsync(new[] { arr.Client }, Ct);

        Assert.Equal(4, list.Count);
        Assert.True(watch.Elapsed < QualityProfileService.ReadBudget + TimeSpan.FromSeconds(5));
    }

    [Fact]
    public async Task A_deleted_profile_is_removed_from_the_manager_on_the_next_sync()
    {
        using var node = new TempNode();
        var arr = new FakeArr();
        await node.Service.SaveAsync(Profile("Mine", "720p"), mustExist: false, Ct);
        await node.Service.SyncAsync(arr.Client, new SyncStatus(), Ct);
        Assert.Contains("Mine", arr.Names);

        await node.Service.DeleteAsync("Mine", Array.Empty<ArrClient>(), Ct);
        await node.Service.SyncAsync(arr.Client, new SyncStatus(), Ct);

        Assert.DoesNotContain("Mine", arr.Names);
    }

    [Fact]
    public async Task A_delete_is_refused_while_a_running_manager_has_titles_on_the_profile()
    {
        using var node = new TempNode();
        var arr = new FakeArr();
        await node.Service.SaveAsync(Profile("Mine", "720p"), mustExist: false, Ct);
        await node.Service.SyncAsync(arr.Client, new SyncStatus(), Ct);
        arr.Movies.Add(Movie(1, arr.IdOf("Mine")));

        var result = await node.Service.DeleteAsync("Mine", new[] { arr.Client }, Ct);

        Assert.False(result.Ok);
        Assert.False(result.NotFound);
        Assert.Contains("in use", result.Message, StringComparison.Ordinal);
        Assert.NotNull(node.Service.Find("Mine"));
    }

    [Fact]
    public async Task A_profile_deleted_while_the_manager_was_down_has_its_titles_moved_to_the_default()
    {
        using var node = new TempNode();
        var arr = new FakeArr();
        await node.Service.SaveAsync(Profile("Mine", "720p"), mustExist: false, Ct);
        await node.Service.SyncAsync(arr.Client, new SyncStatus(), Ct);
        arr.Movies.Add(Movie(1, arr.IdOf("Mine")));
        arr.Movies.Add(Movie(2, arr.IdOf("Low")));

        await node.Service.DeleteAsync("Mine", Array.Empty<ArrClient>(), Ct);
        var status = new SyncStatus();
        await node.Service.SyncAsync(arr.Client, status, Ct);

        Assert.DoesNotContain("Mine", arr.Names);
        Assert.Equal(arr.IdOf("Medium"), arr.Movies[0]["qualityProfileId"]!.GetValue<int>());
        Assert.Equal(arr.IdOf("Low"), arr.Movies[1]["qualityProfileId"]!.GetValue<int>());
    }

    // --- mapping -------------------------------------------------------------------------------

    [Fact]
    public void A_profile_of_one_quality_matches_its_own_tier()
    {
        var arr = new FakeArr("WebOnly");
        arr.Allow("WebOnly", "HDTV-1080p", cutoff: 9);
        var raw = arr.Profile("WebOnly");

        var stored = QualityProfileService.FromManager(raw);

        Assert.Equal(new[] { "1080p" }, stored.Tiers);
        Assert.Equal("1080p", stored.CutoffTier);
        Assert.True(QualityProfileService.Matches(stored, raw));
    }

    private static QualityProfileView Profile(string name, params string[] tiers) => new()
    {
        Name = name,
        Tiers = tiers.ToList(),
        CutoffTier = tiers[^1],
        UpgradeAllowed = true,
    };

    private static JsonObject Movie(int id, int profileId) => new()
    {
        ["id"] = id,
        ["qualityProfileId"] = profileId,
    };

    private static bool Allowed(JsonObject profile, string quality)
        => profile["items"]!.AsArray().OfType<JsonObject>()
            .Single(i => i["quality"]!["name"]!.GetValue<string>() == quality)["allowed"]!
            .GetValue<bool>();

    /// <summary>Just enough of a movie manager's <c>qualityprofile</c> and <c>movie</c> API.</summary>
    private sealed class FakeArr : HttpMessageHandler
    {
        private int _nextId = 100;

        public FakeArr(params string[] stock)
        {
            foreach (var name in stock)
            {
                var profile = Schema();
                profile["id"] = _nextId++;
                profile["name"] = name;
                Profiles.Add(profile);
            }

            Client = new ArrClient(
                ArrKind.Radarr,
                new ChildRuntime { Enabled = true, BaseUrl = "http://arr.test", ApiKey = "key" },
                new HttpClient(this),
                NullLogger.Instance);
        }

        public List<JsonObject> Profiles { get; } = new();

        public List<JsonObject> Movies { get; } = new();

        public ArrClient Client { get; }

        /// <summary>Every POST and PUT to a profile.</summary>
        public int Writes { get; set; }

        /// <summary>Accept the connection and never answer, like a manager migrating its database.</summary>
        public bool Hang { get; set; }

        public IEnumerable<string> Names => Profiles.Select(p => p["name"]!.GetValue<string>());

        public JsonObject Profile(string name) => Profiles.Single(p => p["name"]!.GetValue<string>() == name);

        public int IdOf(string name) => Profile(name)["id"]!.GetValue<int>();

        /// <summary>Allow exactly one quality in a profile.</summary>
        public void Allow(string name, string quality, int cutoff)
        {
            var profile = Profile(name);
            foreach (var item in profile["items"]!.AsArray().OfType<JsonObject>())
            {
                item["allowed"] = item["quality"]!["name"]!.GetValue<string>() == quality;
            }

            profile["cutoff"] = cutoff;
            profile["upgradeAllowed"] = true;
        }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            if (Hang)
            {
                await Task.Delay(Timeout.Infinite, cancellationToken);
            }

            var path = request.RequestUri!.AbsolutePath.TrimEnd('/');

            if (request.Method == HttpMethod.Get && path.EndsWith("/qualityprofile/schema", StringComparison.Ordinal))
            {
                return Json(Schema());
            }

            if (request.Method == HttpMethod.Get && path.EndsWith("/qualityprofile", StringComparison.Ordinal))
            {
                return Json(new JsonArray(Profiles.Select(p => (JsonNode)p.DeepClone()).ToArray()));
            }

            if (request.Method == HttpMethod.Get && path.EndsWith("/movie", StringComparison.Ordinal))
            {
                return Json(new JsonArray(Movies.Select(m => (JsonNode)m.DeepClone()).ToArray()));
            }

            if (request.Method == HttpMethod.Put && path.EndsWith("/movie/editor", StringComparison.Ordinal))
            {
                var edit = JsonNode.Parse(await request.Content!.ReadAsStringAsync(cancellationToken))!.AsObject();
                var to = edit["qualityProfileId"]!.GetValue<int>();
                var ids = edit["movieIds"]!.AsArray().Select(n => n!.GetValue<int>()).ToHashSet();
                foreach (var movie in Movies.Where(m => ids.Contains(m["id"]!.GetValue<int>())))
                {
                    movie["qualityProfileId"] = to;
                }

                return Json(new JsonArray());
            }

            if (request.Method == HttpMethod.Post && path.EndsWith("/qualityprofile", StringComparison.Ordinal))
            {
                Writes++;
                var body = JsonNode.Parse(await request.Content!.ReadAsStringAsync(cancellationToken))!.AsObject();
                body["id"] = _nextId++;
                Profiles.Add(body);
                return Json(body);
            }

            var id = int.Parse(path[(path.LastIndexOf('/') + 1)..], System.Globalization.CultureInfo.InvariantCulture);
            if (request.Method == HttpMethod.Put)
            {
                Writes++;
                var body = JsonNode.Parse(await request.Content!.ReadAsStringAsync(cancellationToken))!.AsObject();
                Profiles[Profiles.FindIndex(p => p["id"]!.GetValue<int>() == id)] = body;
                return Json(body);
            }

            if (Movies.Any(m => m["qualityProfileId"]!.GetValue<int>() == id))
            {
                return new HttpResponseMessage(HttpStatusCode.BadRequest)
                {
                    Content = new StringContent($"{{\"message\":\"QualityProfile [{id}] is in use.\"}}", Encoding.UTF8, "application/json"),
                };
            }

            Profiles.RemoveAll(p => p["id"]!.GetValue<int>() == id);
            return new HttpResponseMessage(HttpStatusCode.OK);
        }

        private static HttpResponseMessage Json(JsonNode node) => new(HttpStatusCode.OK)
        {
            Content = new StringContent(node.ToJsonString(), Encoding.UTF8, "application/json"),
        };

        private static JsonObject Schema() => new()
        {
            ["name"] = string.Empty,
            ["upgradeAllowed"] = false,
            ["cutoff"] = 0,
            ["items"] = new JsonArray
            {
                Quality(1, "SDTV"),
                Quality(4, "HDTV-720p"),
                Quality(9, "HDTV-1080p"),
                Quality(7, "Bluray-1080p"),
                Quality(30, "Remux-1080p"),
                Quality(19, "Bluray-2160p"),
            },
        };

        private static JsonObject Quality(int id, string name) => new()
        {
            ["quality"] = new JsonObject { ["id"] = id, ["name"] = name },
            ["items"] = new JsonArray(),
            ["allowed"] = false,
        };
    }

    /// <summary>A throwaway data directory with a real <c>core.db</c>, and the service over it.</summary>
    private sealed class TempNode : IDisposable
    {
        private readonly string _dir;
        private readonly CoreDatabase _db;

        public TempNode()
        {
            _dir = Path.Combine(Path.GetTempPath(), "stingstream-core-tests", Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_dir);
            _db = new CoreDatabase(NullLogger<CoreDatabase>.Instance, new DirOnly(_dir));
            _db.EnsureInitialized();
            Settings = new SettingsStore(_db, NullLogger<SettingsStore>.Instance);
            Service = new QualityProfileService(null!, Settings, NullLogger<QualityProfileService>.Instance);
        }

        public SettingsStore Settings { get; }

        public QualityProfileService Service { get; }

        public void Dispose()
        {
            Settings.Dispose();
            _db.Dispose();
            try
            {
                Directory.Delete(_dir, recursive: true);
            }
            catch (IOException)
            {
                // SQLite's pool can hold the file for a moment on Windows; a stray temp dir is fine.
            }
            catch (UnauthorizedAccessException)
            {
            }
        }
    }

    private sealed class DirOnly : INodeRuntimeProvider
    {
        public DirOnly(string dir) => DataDirectory = dir;

        public string? DataDirectory { get; }

        public string? RuntimeJsonPath => Path.Combine(DataDirectory!, "runtime.json");

        public NodeRuntime? Current => null;

        public void ClearFirstRun()
        {
        }

        public void SetServerName(string name)
        {
        }
    }
}
