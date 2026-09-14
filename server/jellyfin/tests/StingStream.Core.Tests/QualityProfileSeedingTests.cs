using System.Collections.Generic;
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
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// Replacing a manager's stock quality profiles with Any, High, Medium and Low.
/// </summary>
/// <remarks>
/// Runs against a fake manager over HTTP rather than a mock of the client, so the requests the
/// service actually sends are the ones being judged.
/// </remarks>
public class QualityProfileSeedingTests
{
    [Fact]
    public async Task First_contact_leaves_only_the_built_ins_and_anything_still_in_use()
    {
        var arr = new FakeArr("Any", "SD", "HD-1080p");
        arr.InUse.Add(arr.IdOf("HD-1080p"));

        await Service().EnsureBuiltInsAsync(arr.Client, removeOthers: true);

        Assert.Equal(
            new[] { "Any", "HD-1080p", "High", "Low", "Medium" },
            arr.Profiles.Select(p => p["name"]!.GetValue<string>()).OrderBy(n => n));
    }

    [Fact]
    public async Task First_contact_rewrites_the_stock_profile_that_shares_a_built_in_name()
    {
        // Both managers ship an "Any" that takes remuxes. Keeping it because the name matched would
        // leave the one profile called Any doing something the built-in never does.
        var arr = new FakeArr("Any");
        foreach (var item in arr.Profiles[0]["items"]!.AsArray().OfType<JsonObject>())
        {
            item["allowed"] = true;
        }

        await Service().EnsureBuiltInsAsync(arr.Client, removeOthers: true);

        var any = arr.Profiles.Single(p => p["name"]!.GetValue<string>() == "Any");
        Assert.False(Allowed(any, "Remux-1080p"));
        Assert.True(Allowed(any, "SDTV"));
        Assert.True(Allowed(any, "Bluray-2160p"));
    }

    [Fact]
    public async Task Later_passes_recreate_a_missing_built_in_and_touch_nothing_else()
    {
        var arr = new FakeArr("Any", "High", "Medium", "Mine");
        var anyBefore = arr.Profiles[0].ToJsonString();

        await Service().EnsureBuiltInsAsync(arr.Client, removeOthers: false);

        var names = arr.Profiles.Select(p => p["name"]!.GetValue<string>()).ToList();
        Assert.Contains("Mine", names);
        Assert.Contains("Low", names);
        Assert.Equal(anyBefore, arr.Profiles[0].ToJsonString());
    }

    [Fact]
    public async Task Medium_is_written_with_its_tiers_and_cutoff()
    {
        var arr = new FakeArr();

        await Service().EnsureBuiltInsAsync(arr.Client, removeOthers: true);

        var medium = arr.Profiles.Single(p => p["name"]!.GetValue<string>() == "Medium");
        Assert.True(Allowed(medium, "HDTV-720p"));
        Assert.True(Allowed(medium, "Bluray-1080p"));
        Assert.False(Allowed(medium, "SDTV"));
        Assert.False(Allowed(medium, "Bluray-2160p"));
        Assert.Equal(7, medium["cutoff"]!.GetValue<int>());
        Assert.True(medium["upgradeAllowed"]!.GetValue<bool>());
    }

    private static QualityProfileService Service()
        => new(null!, null!, NullLogger<QualityProfileService>.Instance);

    private static bool Allowed(JsonObject profile, string quality)
        => profile["items"]!.AsArray().OfType<JsonObject>()
            .Single(i => i["quality"]!["name"]!.GetValue<string>() == quality)["allowed"]!
            .GetValue<bool>();

    /// <summary>Just enough of a manager's <c>qualityprofile</c> API.</summary>
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

        public HashSet<int> InUse { get; } = new();

        public ArrClient Client { get; }

        public int IdOf(string name)
            => Profiles.Single(p => p["name"]!.GetValue<string>() == name)["id"]!.GetValue<int>();

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var path = request.RequestUri!.AbsolutePath.TrimEnd('/');

            if (request.Method == HttpMethod.Get && path.EndsWith("/qualityprofile/schema", System.StringComparison.Ordinal))
            {
                return Json(Schema());
            }

            if (request.Method == HttpMethod.Get && path.EndsWith("/qualityprofile", System.StringComparison.Ordinal))
            {
                return Json(new JsonArray(Profiles.Select(p => (JsonNode)p.DeepClone()).ToArray()));
            }

            if (request.Method == HttpMethod.Post && path.EndsWith("/qualityprofile", System.StringComparison.Ordinal))
            {
                var body = JsonNode.Parse(await request.Content!.ReadAsStringAsync(cancellationToken))!.AsObject();
                body["id"] = _nextId++;
                Profiles.Add(body);
                return Json(body);
            }

            var id = int.Parse(path[(path.LastIndexOf('/') + 1)..], System.Globalization.CultureInfo.InvariantCulture);
            if (request.Method == HttpMethod.Put)
            {
                var body = JsonNode.Parse(await request.Content!.ReadAsStringAsync(cancellationToken))!.AsObject();
                Profiles[Profiles.FindIndex(p => p["id"]!.GetValue<int>() == id)] = body;
                return Json(body);
            }

            if (InUse.Contains(id))
            {
                return new HttpResponseMessage(HttpStatusCode.BadRequest)
                {
                    Content = new StringContent("[{\"errorMessage\":\"Profile is in use\"}]", Encoding.UTF8, "application/json"),
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
}
