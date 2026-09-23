using System.Collections.Generic;
using System.Net;
using StingStream.Core.Arr;
using StingStream.Core.Controllers;
using StingStream.Core.Data;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// Testing, renaming and syncing indexers and download clients.
/// </summary>
/// <remarks>
/// The bug behind these: an indexer that passed in Sonarr's own UI failed in StingStream with
/// "could not test it", because the managers were not running yet and the failure escaped as a
/// bare 500. The direct probe, the summary a person reads, and the rule that decides when a sync
/// is still owed are the parts that can be pinned without a running manager.
/// </remarks>
public class ProviderSettingsTests
{
    private static IndexerSettings Indexer(string baseUrl = "http://prowlarr:9696/1/", string apiPath = "/api", string key = "k+y")
        => new() { Name = "Tracker", BaseUrl = baseUrl, ApiPath = apiPath, ApiKey = key };

    [Fact]
    public void The_probe_url_joins_base_and_path_the_way_the_managers_do()
    {
        Assert.Equal(
            "http://prowlarr:9696/1/api?t=caps&apikey=k%2By",
            TorznabProbe.BuildUrl(Indexer(), "t=caps"));
        Assert.Equal(
            "http://jackett/api/v2.0/indexers/x/results/torznab/api?t=caps",
            TorznabProbe.BuildUrl(Indexer("http://jackett/api/v2.0/indexers/x/results/torznab", "api/", string.Empty), "t=caps"));
    }

    [Fact]
    public void A_caps_document_is_a_pass()
    {
        var result = TorznabProbe.Classify(HttpStatusCode.OK, "<?xml version=\"1.0\"?><caps><server title=\"x\"/></caps>");
        Assert.True(result.Ok);
    }

    [Theory]
    [InlineData("100")]
    [InlineData("101")]
    [InlineData("102")]
    public void A_torznab_credentials_error_reads_as_a_refused_key(string code)
    {
        var result = TorznabProbe.Classify(HttpStatusCode.OK, $"<error code=\"{code}\" description=\"Invalid API Key\"/>");
        Assert.False(result.Ok);
        Assert.Equal("The indexer refused the API key.", result.Message);
    }

    [Fact]
    public void Any_other_torznab_error_carries_its_description()
    {
        var result = TorznabProbe.Classify(HttpStatusCode.OK, "<error code=\"900\" description=\"Indexer is down\"/>");
        Assert.False(result.Ok);
        Assert.Contains("Indexer is down", result.Message, System.StringComparison.Ordinal);
    }

    [Fact]
    public void Html_or_an_http_error_is_a_fail_not_a_crash()
    {
        Assert.False(TorznabProbe.Classify(HttpStatusCode.OK, "<html><body>login</html>").Ok);
        Assert.False(TorznabProbe.Classify(HttpStatusCode.OK, "{\"not\":\"xml\"}").Ok);
        Assert.False(TorznabProbe.Classify(HttpStatusCode.NotFound, string.Empty).Ok);
        Assert.Equal(
            "The indexer refused the API key.",
            TorznabProbe.Classify(HttpStatusCode.Unauthorized, string.Empty).Message);
    }

    [Fact]
    public void The_summary_never_names_radarr_or_sonarr()
    {
        var result = new ConnectivityTestResult();
        result.Apps["radarr"] = new ProviderTestResult { Ok = false, Message = "Unauthorized" };
        result.Apps["sonarr"] = new ProviderTestResult { Ok = false, Message = "Timed out" };
        result.Summarize();

        Assert.False(result.Ok);
        Assert.DoesNotContain("radarr", result.Message, System.StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("sonarr", result.Message, System.StringComparison.OrdinalIgnoreCase);
        Assert.Contains("Movies: Unauthorized", result.Message, System.StringComparison.Ordinal);
        Assert.Contains("TV shows: Timed out", result.Message, System.StringComparison.Ordinal);
    }

    [Fact]
    public void The_same_failure_from_both_apps_reads_once()
    {
        var result = new ConnectivityTestResult();
        result.Apps["radarr"] = new ProviderTestResult { Ok = false, Message = "ApiKey: Unauthorized" };
        result.Apps["sonarr"] = new ProviderTestResult { Ok = false, Message = "ApiKey: Unauthorized" };
        result.Summarize();

        Assert.Equal("ApiKey: Unauthorized", result.Message);
    }

    [Fact]
    public void A_pass_reads_as_connected()
    {
        var result = new ConnectivityTestResult();
        result.Apps["indexer"] = new ProviderTestResult { Ok = true, Message = "Connected." };
        result.Summarize();

        Assert.True(result.Ok);
        Assert.Equal("Connected.", result.Message);
    }

    [Fact]
    public void An_app_with_no_sync_or_a_failed_one_is_behind()
    {
        var settings = new SharedSettings { UpdatedAt = "2026-09-23T10:00:00.0000000Z" };
        var ok = new SyncStatus { App = "radarr", Ok = true, UpdatedAt = "2026-09-23T10:00:05.0000000Z" };

        Assert.True(SyncRetryWorker.IsBehind(settings, new[] { "radarr", "sonarr" }, new[] { ok }));
        Assert.True(SyncRetryWorker.IsBehind(
            settings,
            new[] { "radarr" },
            new[] { new SyncStatus { App = "radarr", Ok = false, UpdatedAt = ok.UpdatedAt } }));
        Assert.False(SyncRetryWorker.IsBehind(settings, new[] { "radarr" }, new[] { ok }));
    }

    [Fact]
    public void A_save_after_the_last_sync_makes_it_behind()
    {
        var settings = new SharedSettings { UpdatedAt = "2026-09-23T10:00:10.0000000Z" };
        var stale = new SyncStatus { App = "sonarr", Ok = true, UpdatedAt = "2026-09-23T10:00:05.0000000Z" };

        Assert.True(SyncRetryWorker.IsBehind(settings, new[] { "sonarr" }, new[] { stale }));
    }

    [Fact]
    public void Retiring_a_name_is_idempotent_and_reusing_it_takes_it_back()
    {
        var settings = new SharedSettings();
        settings.Retire("indexer", "Old");
        settings.Retire("indexer", "old");
        Assert.Single(settings.RetiredProviders);

        settings.Unretire("indexer", "OLD");
        Assert.Empty(settings.RetiredProviders);
    }

    [Fact]
    public void A_whole_document_put_retires_what_it_dropped_and_keeps_the_list()
    {
        var stored = new SharedSettings
        {
            Indexers = new List<IndexerSettings> { new() { Name = "Kept" }, new() { Name = "Dropped" } },
            ExternalDownloadClients = new List<ExternalDownloadClientSettings> { new() { Name = "Seedbox" } },
        };
        stored.Retire("indexer", "Ancient");

        var incoming = new SharedSettings
        {
            Indexers = new List<IndexerSettings> { new() { Name = "Kept" } },
        };
        SharedSettings.PreserveServerOwned(incoming, stored);

        Assert.Contains(incoming.RetiredProviders, r => r is { Resource: "indexer", Name: "Ancient" });
        Assert.Contains(incoming.RetiredProviders, r => r is { Resource: "indexer", Name: "Dropped" });
        Assert.Contains(incoming.RetiredProviders, r => r is { Resource: "downloadclient", Name: "Seedbox" });
        Assert.DoesNotContain(incoming.RetiredProviders, r => r.Name == "Kept");
    }
}
