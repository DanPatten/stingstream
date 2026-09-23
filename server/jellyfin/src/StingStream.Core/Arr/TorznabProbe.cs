using System;
using System.Globalization;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using System.Xml;
using System.Xml.Linq;
using StingStream.Core.Data;

namespace StingStream.Core.Arr;

/// <summary>
/// Asks a Torznab indexer directly whether it answers, without going through Radarr or Sonarr.
/// </summary>
/// <remarks>
/// <para>
/// The managers only run once an enabled indexer exists (<see cref="ArrEnablement"/>), so the
/// first indexer anybody adds is tested while neither of them is up to be asked. The test used to
/// call the stopped manager's <c>indexer/schema</c> regardless, and a refused connection outside
/// the controller's try became Jellyfin's bare 500, which the app drew as "could not test it" while
/// the very same indexer passed in Sonarr's own UI.
/// </para>
/// <para>
/// This covers the two things the managers' own Torznab test checks: <c>t=caps</c> answers with
/// capabilities, and a one-result search is not refused. The managers' test remains the one used
/// whenever they are running, because it is the one a save is judged by.
/// </para>
/// </remarks>
public sealed class TorznabProbe
{
    /// <summary>Name of the <see cref="IHttpClientFactory"/> client used for indexer traffic.</summary>
    public const string HttpClientName = "StingStream.Torznab";

    private readonly IHttpClientFactory _httpFactory;

    public TorznabProbe(IHttpClientFactory httpFactory)
    {
        _httpFactory = httpFactory;
    }

    /// <summary>Test one indexer.</summary>
    /// <param name="indexer">The indexer, stored or not.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The verdict, with a sentence for a person.</returns>
    public async Task<ProviderTestResult> TestAsync(IndexerSettings indexer, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(indexer);

        var caps = await GetAsync(BuildUrl(indexer, "t=caps"), ct).ConfigureAwait(false);
        if (!caps.Ok)
        {
            return caps;
        }

        return await GetAsync(BuildUrl(indexer, "t=search&limit=1"), ct).ConfigureAwait(false);
    }

    /// <summary>The request URL, the way both managers build it.</summary>
    /// <param name="indexer">The indexer.</param>
    /// <param name="query">The query string, without <c>apikey</c>.</param>
    /// <returns>The absolute URL.</returns>
    public static string BuildUrl(IndexerSettings indexer, string query)
    {
        ArgumentNullException.ThrowIfNull(indexer);

        var apiPath = (indexer.ApiPath ?? string.Empty).Trim().TrimEnd('/');
        if (apiPath.Length > 0 && !apiPath.StartsWith('/'))
        {
            apiPath = "/" + apiPath;
        }

        var url = string.Concat(indexer.BaseUrl.Trim().TrimEnd('/'), apiPath, "?", query);
        return string.IsNullOrWhiteSpace(indexer.ApiKey)
            ? url
            : string.Concat(url, "&apikey=", Uri.EscapeDataString(indexer.ApiKey.Trim()));
    }

    /// <summary>
    /// Judge one Torznab response.
    /// </summary>
    /// <param name="status">The HTTP status.</param>
    /// <param name="body">The response body.</param>
    /// <returns>The verdict.</returns>
    /// <remarks>
    /// Torznab reports its own failures as a 200 carrying <c>&lt;error code="…"
    /// description="…"/&gt;</c>, so a success status alone proves nothing. Codes 100 to 102 are
    /// all some form of "that key is no good".
    /// </remarks>
    public static ProviderTestResult Classify(HttpStatusCode status, string body)
    {
        if (status is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
        {
            return Fail("The indexer refused the API key.", status);
        }

        if ((int)status is < 200 or > 299)
        {
            return Fail(
                string.Create(CultureInfo.InvariantCulture, $"The indexer answered with an error ({(int)status})."),
                status);
        }

        XElement root;
        try
        {
            root = XDocument.Parse(body ?? string.Empty).Root
                ?? throw new XmlException("No root element.");
        }
        catch (XmlException)
        {
            return Fail("This address does not answer like a Torznab indexer. Check the URL and API path.", status);
        }

        if (string.Equals(root.Name.LocalName, "error", StringComparison.OrdinalIgnoreCase))
        {
            var code = (string?)root.Attribute("code");
            if (code is "100" or "101" or "102")
            {
                return Fail("The indexer refused the API key.", status);
            }

            var description = (string?)root.Attribute("description");
            return Fail(
                string.IsNullOrWhiteSpace(description)
                    ? "The indexer reported an error."
                    : $"The indexer reported an error: {description.Trim()}",
                status);
        }

        return new ProviderTestResult { Ok = true, Message = "Connected." };
    }

    private async Task<ProviderTestResult> GetAsync(string url, CancellationToken ct)
    {
        var http = _httpFactory.CreateClient(HttpClientName);
        try
        {
            using var res = await http.GetAsync(new Uri(url), ct).ConfigureAwait(false);
            var body = await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            return Classify(res.StatusCode, body);
        }
        catch (UriFormatException)
        {
            return Fail("The URL is not valid.", null);
        }
        catch (HttpRequestException)
        {
            return Fail("Could not reach the indexer. Check the URL and that it is running.", null);
        }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested)
        {
            return Fail("The indexer did not answer in time.", null);
        }
    }

    private static ProviderTestResult Fail(string message, HttpStatusCode? status)
        => new() { Ok = false, Message = message, Status = status is null ? null : (int)status };
}
