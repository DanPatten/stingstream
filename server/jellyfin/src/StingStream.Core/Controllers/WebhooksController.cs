using System.IO;
using System.Net;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using StingStream.Core.Webhooks;

namespace StingStream.Core.Controllers;

/// <summary>
/// Receives Radarr's and Sonarr's webhook events.
/// </summary>
/// <remarks>
/// Anonymous by necessity: Radarr and Sonarr have no Jellyfin token to present, and their Webhook
/// notification only offers HTTP Basic. Instead the endpoint is restricted to callers on the
/// loopback interface, which is exactly where the arrs live -- the supervisor binds every child to
/// 127.0.0.1 and configures the webhook URL as <c>http://127.0.0.1:{jellyfinPort}/...</c>. A
/// request arriving from anywhere else is not one of our children and is refused.
/// </remarks>
[ApiController]
[AllowAnonymous]
[Route("stingstream/api/v1/webhooks")]
[ApiExplorerSettings(GroupName = StingStreamApi.DocumentName)]
public sealed class WebhooksController : ControllerBase
{
    private readonly ArrWebhookService _service;
    private readonly ILogger<WebhooksController> _logger;

    public WebhooksController(ArrWebhookService service, ILogger<WebhooksController> logger)
    {
        _service = service;
        _logger = logger;
    }

    /// <summary>
    /// Accept a Radarr or Sonarr webhook and trigger a targeted Jellyfin refresh of the path it
    /// names.
    /// </summary>
    /// <param name="app">Which app sent it. Inferred from the payload when absent.</param>
    /// <response code="200">What the delivery did.</response>
    /// <response code="400">The body was not JSON.</response>
    /// <response code="403">The caller is not on the loopback interface.</response>
    [HttpPost("arr")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    public async Task<IActionResult> Arr([FromQuery] string? app, CancellationToken cancellationToken)
    {
        if (!IsLoopback())
        {
            _logger.LogWarning(
                "Refused an arr webhook from {Address}: this endpoint only accepts loopback callers",
                HttpContext.Connection.RemoteIpAddress);
            return Forbid();
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
