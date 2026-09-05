using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Text.Json.Nodes;
using StingStream.Core.Arr;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// Mapping one shared quality profile onto one app's own quality tree.
/// </summary>
/// <remarks>
/// This is the half of gap 4 that could go wrong quietly. A profile is shared across Radarr and
/// Sonarr and carried by quality <em>name</em>, while each app stores integer ids over its own
/// definition list — so the mapping has to survive a name one app does not have, a cutoff that is
/// not among the allowed qualities, and NzbDrone's rule that every member of an allowed group must
/// itself be allowed.
/// </remarks>
public class QualityProfileMappingTests
{
    /// <summary>A schema shaped like the one either app returns from <c>qualityprofile/schema</c>.</summary>
    private static JsonObject Schema() => new()
    {
        ["name"] = string.Empty,
        ["upgradeAllowed"] = false,
        ["cutoff"] = 0,
        ["items"] = new JsonArray
        {
            Group(
                1002,
                "WEB 2160p",
                (18, "WEBDL-2160p"),
                (17, "WEBRip-2160p")),
            Quality(19, "Bluray-2160p"),
            Group(
                1001,
                "WEB 1080p",
                (3, "WEBDL-1080p"),
                (15, "WEBRip-1080p")),
            Quality(7, "Bluray-1080p"),
            Quality(4, "HDTV-720p"),
        },
    };

    private static JsonObject Quality(int id, string name) => new()
    {
        ["quality"] = new JsonObject { ["id"] = id, ["name"] = name },
        ["items"] = new JsonArray(),
        ["allowed"] = false,
    };

    private static JsonObject Group(int id, string name, params (int Id, string Name)[] members)
    {
        var items = new JsonArray();
        foreach (var m in members)
        {
            items.Add(Quality(m.Id, m.Name));
        }

        return new JsonObject
        {
            ["id"] = id,
            ["name"] = name,
            ["items"] = items,
            ["allowed"] = false,
        };
    }

    private static QualityProfileView Wanted(string cutoff, params string[] allowed) => new()
    {
        Name = "1080p",
        UpgradeAllowed = true,
        Cutoff = cutoff,
        Items = allowed
            .Select(a => new QualityProfileItemView { Name = a, Allowed = true })
            .ToList(),
    };

    private static bool AllowedOf(JsonObject schema, string name)
    {
        foreach (var item in schema["items"]!.AsArray().OfType<JsonObject>())
        {
            var itemName = item["name"]?.GetValue<string>()
                ?? (item["quality"] as JsonObject)?["name"]?.GetValue<string>();
            if (itemName == name)
            {
                return item["allowed"]!.GetValue<bool>();
            }

            foreach (var member in (item["items"] as JsonArray ?? new JsonArray()).OfType<JsonObject>())
            {
                if ((member["quality"] as JsonObject)?["name"]?.GetValue<string>() == name)
                {
                    return member["allowed"]!.GetValue<bool>();
                }
            }
        }

        return false;
    }

    [Fact]
    public void Naming_one_member_allows_its_whole_group()
    {
        // The shared model's checkbox list is flat; Radarr's tree is not. A user ticking
        // "WEBDL-1080p" means the group it lives in, and NzbDrone rejects a profile with an allowed
        // group whose members are not all allowed.
        var schema = Schema();
        var allowed = new HashSet<string>(new[] { "WEBDL-1080p", "Bluray-1080p" });

        QualityProfileService.Apply(schema, Wanted("Bluray-1080p", "WEBDL-1080p", "Bluray-1080p"), allowed, out _);

        Assert.True(AllowedOf(schema, "WEB 1080p"), "the group is allowed");
        Assert.True(AllowedOf(schema, "WEBDL-1080p"));
        Assert.True(AllowedOf(schema, "WEBRip-1080p"), "every member of an allowed group must be allowed");
        Assert.True(AllowedOf(schema, "Bluray-1080p"));
        Assert.False(AllowedOf(schema, "HDTV-720p"));
        Assert.False(AllowedOf(schema, "WEB 2160p"));
    }

    [Fact]
    public void The_group_flip_reaches_members_listed_before_the_one_that_caused_it()
    {
        // The bug this exists to catch: deciding the group's state while walking its members, and
        // writing as you go, leaves every member *before* the one that flipped it set to false.
        // "WEBRip-1080p" is the second member of its group and the only one named.
        var schema = Schema();
        var allowed = new HashSet<string>(new[] { "WEBRip-1080p" });

        QualityProfileService.Apply(schema, Wanted("WEBRip-1080p", "WEBRip-1080p"), allowed, out _);

        Assert.True(AllowedOf(schema, "WEBDL-1080p"), "the first member must have been revisited");
        Assert.True(AllowedOf(schema, "WEBRip-1080p"));
    }

    [Fact]
    public void The_cutoff_becomes_the_named_quality_s_id()
    {
        var schema = Schema();
        var allowed = new HashSet<string>(new[] { "Bluray-1080p", "WEBDL-1080p" });

        QualityProfileService.Apply(schema, Wanted("Bluray-1080p", "Bluray-1080p", "WEBDL-1080p"), allowed, out var found);

        Assert.True(found);
        Assert.Equal(7, schema["cutoff"]!.GetValue<int>());
    }

    [Fact]
    public void A_cutoff_naming_a_quality_inside_a_group_resolves_to_the_group()
    {
        // Found by running it: NzbDrone stores the cutoff as one id, and a quality that lives
        // inside a group has no addressable id of its own — so "upgrade until WEBDL-1080p" can
        // only mean "until the WEB 1080p group". Matching only top-level names made *every* cutoff
        // inside a group silently fall back to the lowest allowed quality, which is very nearly
        // the opposite of what was asked for, and the picker offers member names because that is
        // what the shared vocabulary is made of.
        var schema = Schema();
        var allowed = new HashSet<string>(new[] { "WEBDL-1080p", "Bluray-1080p" });

        QualityProfileService.Apply(
            schema,
            Wanted("WEBDL-1080p", "WEBDL-1080p", "Bluray-1080p"),
            allowed,
            out var found);

        Assert.True(found);
        Assert.Equal(1001, schema["cutoff"]!.GetValue<int>());
    }

    [Fact]
    public void A_cutoff_that_is_not_allowed_falls_back_to_the_lowest_allowed_quality()
    {
        // Both apps reject a profile whose cutoff is a disallowed quality outright, so there is no
        // "store it and warn" option -- the choice is a sensible substitute or a failed save.
        var schema = Schema();
        var allowed = new HashSet<string>(new[] { "Bluray-2160p", "Bluray-1080p" });

        QualityProfileService.Apply(schema, Wanted("HDTV-720p", "Bluray-2160p", "Bluray-1080p"), allowed, out var found);

        Assert.False(found);
        Assert.Equal(7, schema["cutoff"]!.GetValue<int>());
    }

    [Fact]
    public void A_quality_this_app_does_not_have_is_reported_rather_than_dropped()
    {
        // Radarr has Bluray-2160p Remux and Sonarr does not. Silently dropping it would make the
        // two apps disagree with no way for the UI to say so.
        var schema = Schema();
        var allowed = new HashSet<string>(new[] { "Bluray-1080p", "Bluray-2160p Remux" });

        var missing = QualityProfileService.Apply(
            schema,
            Wanted("Bluray-1080p", "Bluray-1080p", "Bluray-2160p Remux"),
            allowed,
            out _);

        Assert.Equal(new[] { "Bluray-2160p Remux" }, missing);
        Assert.True(AllowedOf(schema, "Bluray-1080p"));
    }

    [Fact]
    public void Flatten_walks_groups_and_their_members()
    {
        var items = new List<QualityProfileItemView>
        {
            new()
            {
                Name = "WEB 1080p",
                IsGroup = true,
                Items = new List<QualityProfileItemView>
                {
                    new() { Name = "WEBDL-1080p" },
                    new() { Name = "WEBRip-1080p" },
                },
            },
            new() { Name = "Bluray-1080p" },
        };

        Assert.Equal(
            new[] { "WEB 1080p", "WEBDL-1080p", "WEBRip-1080p", "Bluray-1080p" },
            QualityProfileService.Flatten(items).ToArray());
    }

    [Fact]
    public void A_validation_failure_becomes_one_sentence_that_names_the_field()
    {
        // NzbDrone answers a failed test with an array of per-field failures and a 400. "ApiKey:
        // Unauthorized" says which half of a Torznab URL is wrong; "Unauthorized" alone does not.
        const string body = """
            [{"propertyName":"ApiKey","errorMessage":"Unauthorized","isWarning":false},
             {"propertyName":"BaseUrl","errorMessage":"Unable to connect to indexer"}]
            """;

        var message = ArrClient.DescribeValidationFailure(body, HttpStatusCode.BadRequest);

        Assert.Equal("ApiKey: Unauthorized; BaseUrl: Unable to connect to indexer", message);
    }

    [Fact]
    public void A_failure_that_is_not_json_still_says_something()
    {
        Assert.Equal(
            "502 BadGateway",
            ArrClient.DescribeValidationFailure(string.Empty, HttpStatusCode.BadGateway));
        Assert.Contains(
            "nginx",
            ArrClient.DescribeValidationFailure("<html>502 nginx</html>", HttpStatusCode.BadGateway),
            System.StringComparison.Ordinal);
    }
}
