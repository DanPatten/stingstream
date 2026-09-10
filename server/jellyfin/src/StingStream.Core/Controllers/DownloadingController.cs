using System;
using System.Collections.Generic;
using System.IO;
using MediaBrowser.Common.Api;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using StingStream.Core.Configuration;

namespace StingStream.Core.Controllers;

/// <summary>
/// Whether this node fetches things it does not have yet.
/// </summary>
/// <remarks>
/// <para>
/// One switch, and the reason it needs an endpoint at all: everything behind Requests, the
/// indexers, the quality profiles and the file-naming rules is served by child processes that
/// <c>config.toml</c> can switch off, and until now the only way to switch them back on was to
/// edit that file on the server's own disk and restart the node. The app could describe that
/// situation and do nothing about it, which is how "Requests are not set up on this server" led an
/// administrator to a page that said the same thing again.
/// </para>
/// <para>
/// This writes the file. The supervisor is watching it (<c>supervisor::downloading</c>) and starts
/// or stops the children to match within a few seconds, so the answer to "did it work" is
/// <c>/healthz</c>, which the app already reads — not this endpoint's response. That is why the
/// PUT reports what was asked for rather than pretending to report what is running: it would be
/// guessing, and the honest source is a couple of seconds behind it.
/// </para>
/// <para>
/// <c>RequiresElevation</c> throughout. This decides what processes the server runs.
/// </para>
/// </remarks>
[Authorize(Policy = Policies.RequiresElevation)]
public sealed class DownloadingController : StingStreamControllerBase
{
    private readonly INodeRuntimeProvider _runtime;
    private readonly ILogger<DownloadingController> _logger;

    public DownloadingController(
        INodeRuntimeProvider runtime,
        ILogger<DownloadingController> logger)
    {
        _runtime = runtime;
        _logger = logger;
    }

    /// <summary>What downloading is switched to.</summary>
    /// <response code="200">The switches.</response>
    /// <response code="503">This server was not started by the StingStream supervisor, so there is no config.toml to read.</response>
    /// <returns>The switches.</returns>
    [HttpGet]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status503ServiceUnavailable)]
    public ActionResult<DownloadingSettings> Get()
    {
        if (ConfigPath() is not { } path)
        {
            return StatusCode(StatusCodes.Status503ServiceUnavailable);
        }

        try
        {
            var flags = DownloadingSwitch.Read(path);
            return Ok(DownloadingSettings.From(flags));
        }
        catch (IOException ex)
        {
            _logger.LogWarning(ex, "Could not read config.toml");
            return StatusCode(StatusCodes.Status503ServiceUnavailable);
        }
    }

    /// <summary>Turn downloading on or off.</summary>
    /// <param name="body">What each switch should become. An omitted switch is left as it is.</param>
    /// <response code="200">The switches, as asked for.</response>
    /// <response code="400">config.toml does not carry one of these settings in a shape that can be changed safely.</response>
    /// <response code="503">This server was not started by the StingStream supervisor.</response>
    /// <returns>The switches.</returns>
    /// <remarks>
    /// Omitted rather than false-by-default: a screen that only shows the film manager must not
    /// silently turn the usenet engine off because its checkbox was not on the page.
    /// </remarks>
    [HttpPut]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status503ServiceUnavailable)]
    public ActionResult<DownloadingSettings> Put([FromBody] DownloadingSettings body)
    {
        if (ConfigPath() is not { } path)
        {
            return StatusCode(StatusCodes.Status503ServiceUnavailable);
        }

        var wanted = new Dictionary<string, bool?>(StringComparer.Ordinal)
        {
            ["radarr"] = body.Films,
            ["sonarr"] = body.Series,
            ["nzbget"] = body.Usenet,
        };

        try
        {
            foreach (var (key, value) in wanted)
            {
                if (value is not { } enabled)
                {
                    continue;
                }

                if (DownloadingSwitch.Write(path, key, enabled))
                {
                    _logger.LogInformation(
                        "Downloading: {Child} switched {State} from the app",
                        key,
                        enabled ? "on" : "off");
                }
            }
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(new { error = ex.Message });
        }
        catch (IOException ex)
        {
            _logger.LogWarning(ex, "Could not write config.toml");
            return StatusCode(StatusCodes.Status503ServiceUnavailable);
        }

        return Ok(DownloadingSettings.From(DownloadingSwitch.Read(path)));
    }

    private string? ConfigPath()
    {
        if (_runtime.DataDirectory is not { } dir)
        {
            return null;
        }

        var path = DownloadingSwitch.PathFor(dir);
        return System.IO.File.Exists(path) ? path : null;
    }
}

/// <summary>The three switches, named for what they do rather than for what runs.</summary>
/// <remarks>
/// <c>films</c>/<c>series</c>/<c>usenet</c>, not <c>radarr</c>/<c>sonarr</c>/<c>nzbget</c>: this is
/// the boundary where the node's internals stop and the app's vocabulary starts, and the app is one
/// application to the person using it (see the repository's CLAUDE.md, "StingStream is one app").
/// The mapping to child names lives on the other side of this type, in one place.
/// </remarks>
public sealed class DownloadingSettings
{
    /// <summary>Whether this node fetches films.</summary>
    public bool? Films { get; set; }

    /// <summary>Whether this node fetches series.</summary>
    public bool? Series { get; set; }

    /// <summary>Whether this node fetches over usenet as well as over BitTorrent.</summary>
    public bool? Usenet { get; set; }

    internal static DownloadingSettings From(IReadOnlyDictionary<string, bool> flags) => new()
    {
        Films = flags.TryGetValue("radarr", out var films) ? films : null,
        Series = flags.TryGetValue("sonarr", out var series) ? series : null,
        Usenet = flags.TryGetValue("nzbget", out var usenet) ? usenet : null,
    };
}
