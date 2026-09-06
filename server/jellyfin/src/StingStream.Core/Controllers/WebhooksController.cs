using System.IO;
using System.Net;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using StingStream.Core.Configuration;
using StingStream.Core.Webhooks;

namespace StingStream.Core.Controllers;

/// <summary>
/// Receives Radarr's and Sonarr's webhook events.
/// </summary>
/// <remarks>
/// Anonymous by necessity: Radarr and Sonarr have no Jellyfin token to present, and their Webhook
/// notification only offers HTTP Basic. What stands in for authentication is a per-node shared
/// secret in the query string (<see cref="WebhookToken"/>), written into each arr's webhook URL by
/// <c>OmniarrSyncService</c> and compared in constant time here.
///
/// It used to be a loopback check instead, and that check was believed to be worth nothing: the
/// gateway proxies <c>/stingstream/api/*</c> to Jellyfin over 127.0.0.1, so a request from anywhere
/// on the LAN was assumed to reach Core with a loopback remote address and pass. Measured on a
/// running node while the setup endpoints were being built, that is not what happens -- the gateway
/// <em>overwrites</em> <c>x-forwarded-for</c> with the real socket peer and this server trusts it
/// (<c>KnownProxies</c> is preseeded with <c>127.0.0.1</c>), so what arrives here is the true client
/// address, and a spoofed header from the LAN is discarded on the way through. The check does
/// refuse a LAN caller. It is still the second condition and not the only one, because it holds
/// only as long as that configuration does: a node whose <c>KnownProxies</c> was cleared would see
/// every request as loopback again, and nothing here would notice.
/// </remarks>
[ApiController]
[AllowAnonymous]
[Route("stingstream/api/v1/webhooks")]
[ApiExplorerSettings(GroupName = StingStreamApi.DocumentName)]
public sealed class WebhooksController : ControllerBase
{
    private readonly ArrWebhookService _service;
    private readonly INodeRuntimeProvider _runtime;
    private readonly ILogger<WebhooksController> _logger;

    public WebhooksController(
        ArrWebhookService service,
        INodeRuntimeProvider runtime,
        ILogger<WebhooksController> logger)
    {
        _service = service;
        _runtime = runtime;
        _logger = logger;
    }

    /// <summary>
    /// Accept a Radarr or Sonarr webhook and trigger a targeted Jellyfin refresh of the path it
    /// names.
    /// </summary>
    /// <param name="app">Which app sent it. Inferred from the payload when absent.</param>
    /// <param name="token">This node's webhook secret. See <see cref="WebhookToken"/>.</param>
    /// <response code="200">What the delivery did.</response>
    /// <response code="400">The body was not JSON.</response>
    /// <response code="403">The token is wrong, or the caller is not on the loopback interface.</response>
    [HttpPost("arr")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    public async Task<IActionResult> Arr(
        [FromQuery] string? app,
        [FromQuery] string? token,
        CancellationToken cancellationToken)
    {
        var expected = WebhookToken.For(_runtime.Current);
        if (expected is null)
        {
            _logger.LogWarning(
                "Refused an arr webhook: this node has no webhook secret yet (runtime.json is "
                + "missing or incomplete)");
            return StatusCode(StatusCodes.Status403Forbidden);
        }

        if (!WebhookToken.Matches(expected, token))
        {
            _logger.LogWarning(
                "Refused an arr webhook from {Address}: wrong or missing token",
                HttpContext.Connection.RemoteIpAddress);
            return StatusCode(StatusCodes.Status403Forbidden);
        }

        if (!IsLoopback())
        {
            _logger.LogWarning(
                "Refused an arr webhook from {Address}: the token was right but the caller is not "
                + "on this machine, which one of our own children always is",
                HttpContext.Connection.RemoteIpAddress);
            return StatusCode(StatusCodes.Status403Forbidden);
        }

        // Read the body by hand rather than binding it: the two apps' payloads differ, both change
        // shape across versions, and a model-binding failure would turn a working import into a
        // 400 the user only sees in Radarr's log.
        JsonNode? payload;
        using (var reader = new StreamReader(Request.Body))
        {
            var text = await reader.ReadToEndAsync(cancellationToken).ConfigureAwait(false);
            if (string.IsNullOrWhiteSpace(text))
            {
                return BadRequest("Empty body.");
            }

            try
            {
                payload = JsonNode.Parse(text);
            }
            catch (System.Text.Json.JsonException ex)
            {
                _logger.LogWarning(ex, "An arr webhook body was not valid JSON");
                return BadRequest("Body is not valid JSON.");
            }
        }

        var result = await _service.HandleAsync(app, payload, cancellationToken).ConfigureAwait(false);
        return Ok(result);
    }

    /// <summary>
    /// Whether the caller is on this machine.
    /// </summary>
    /// <remarks>
    /// Weaker than the token, and load-bearing anyway -- see the class remarks for what was
    /// measured. Every legitimate caller really is on loopback, and one that is not is worth a log
    /// line even when it holds the right secret.
    /// </remarks>
    private bool IsLoopback()
    {
        var address = HttpContext.Connection.RemoteIpAddress;
        if (address is null)
        {
            // No remote address at all means an in-process or unix-socket caller, which is at
            // least as trusted as loopback.
            return true;
        }

        if (IPAddress.IsLoopback(address))
        {
            return true;
        }

        // A v4 address arriving over a dual-stack socket is mapped into v6 space, and
        // IPAddress.IsLoopback does not see through the mapping.
        return address.IsIPv4MappedToIPv6 && IPAddress.IsLoopback(address.MapToIPv4());
    }
}
