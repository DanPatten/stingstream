using System;
using AsyncKeyedLock;
using Microsoft.AspNetCore.Mvc.ApiExplorer;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Microsoft.OpenApi;
using Swashbuckle.AspNetCore.Swagger;
using Swashbuckle.AspNetCore.SwaggerGen;

namespace Jellyfin.Server.Filters;

/// <summary>
/// OpenApi provider with caching.
/// </summary>
internal sealed class CachingOpenApiProvider : ISwaggerProvider
{
    // StingStream patch: the cache key must include the document name.
    //
    // Upstream keys this cache on a bare constant while GetSwagger() takes a documentName, so with
    // more than one Swagger document registered whichever one is requested first is cached and
    // then returned for *every* document URL. StingStream registers a second document
    // ("openapi", served at /stingstream/api/v1/openapi.json) alongside Jellyfin's own
    // "api-docs", so without this the two specs collide. See docs/PATCHES.md.
    private const string CacheKeyPrefix = "openapi.json:";

    private static readonly MemoryCacheEntryOptions _cacheOptions = new() { SlidingExpiration = TimeSpan.FromMinutes(5) };
    private static readonly AsyncNonKeyedLocker _lock = new(1);
    private static readonly TimeSpan _lockTimeout = TimeSpan.FromSeconds(1);

    private readonly IMemoryCache _memoryCache;
    private readonly SwaggerGenerator _swaggerGenerator;
    private readonly SwaggerGeneratorOptions _swaggerGeneratorOptions;
    private readonly ILogger<CachingOpenApiProvider> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="CachingOpenApiProvider"/> class.
    /// </summary>
    /// <param name="optionsAccessor">The options accessor.</param>
    /// <param name="apiDescriptionsProvider">The api descriptions provider.</param>
    /// <param name="schemaGenerator">The schema generator.</param>
    /// <param name="memoryCache">The memory cache.</param>
    /// <param name="logger">The logger.</param>
    public CachingOpenApiProvider(
        IOptions<SwaggerGeneratorOptions> optionsAccessor,
        IApiDescriptionGroupCollectionProvider apiDescriptionsProvider,
        ISchemaGenerator schemaGenerator,
        IMemoryCache memoryCache,
        ILogger<CachingOpenApiProvider> logger)
    {
        _swaggerGeneratorOptions = optionsAccessor.Value;
        _swaggerGenerator = new SwaggerGenerator(_swaggerGeneratorOptions, apiDescriptionsProvider, schemaGenerator);
        _memoryCache = memoryCache;
        _logger = logger;
    }

    /// <inheritdoc />
    public OpenApiDocument GetSwagger(string documentName, string host, string basePath)
    {
        var cacheKey = CacheKeyPrefix + documentName;
        if (_memoryCache.TryGetValue(cacheKey, out OpenApiDocument? openApiDocument) && openApiDocument is not null)
        {
            return AdjustDocument(openApiDocument, host, basePath);
        }

        using var acquired = _lock.LockOrNull(_lockTimeout);
        if (_memoryCache.TryGetValue(cacheKey, out openApiDocument) && openApiDocument is not null)
        {
            return AdjustDocument(openApiDocument, host, basePath);
        }

        if (acquired is null)
        {
            throw new InvalidOperationException("OpenApi document is generating");
        }

        try
        {
            openApiDocument = _swaggerGenerator.GetSwagger(documentName);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "OpenAPI generation error");
            throw;
        }

        _memoryCache.Set(cacheKey, openApiDocument, _cacheOptions);
        return AdjustDocument(openApiDocument, host, basePath);
    }

    private OpenApiDocument AdjustDocument(OpenApiDocument document, string? host, string? basePath)
    {
        document.Servers = _swaggerGeneratorOptions.Servers.Count != 0
            ? _swaggerGeneratorOptions.Servers
            : string.IsNullOrEmpty(host) && string.IsNullOrEmpty(basePath)
                ? []
                : [new OpenApiServer { Url = $"{host}{basePath}" }];

        return document;
    }
}
