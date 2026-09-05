using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;

namespace StingStream.Core.Arr;

/// <summary>
/// One quality profile, as StingStream models it across both arrs.
/// </summary>
/// <remarks>
/// <para>
/// The design decision <c>docs/UI-API-GAPS.md</c> gap 4 flagged, made: a profile is
/// <strong>shared and keyed on its name</strong>, not per-app and keyed on an id. Radarr and Sonarr
/// each assign their own integer ids, and a user who edits "1080p" expects both halves of their
/// library to follow — the whole premise of the Omniarr model is that there is one settings
/// document, not two.
/// </para>
/// <para>
/// What is deliberately <em>not</em> shared is the quality vocabulary. Radarr's definition list and
/// Sonarr's differ (Radarr has film-only sources like <c>Bluray-2160p Remux</c>; Sonarr has
/// broadcast ones like <c>HDTV-1080p</c>), and pretending otherwise would either drop qualities on
/// the way through or invent ones an app would reject. So a profile's items are carried by
/// <em>name</em>, each app is given the subset it recognises, and
/// <see cref="QualityProfileView.Unsupported"/> reports per app what it could not take — an honest
/// answer the UI can show, rather than a silent difference between the two apps.
/// </para>
/// </remarks>
public sealed class QualityProfileView
{
    /// <summary>The profile's name. This is its identity across both apps.</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>Which apps have a profile by this name: <c>radarr</c>, <c>sonarr</c>, or both.</summary>
    public List<string> Apps { get; set; } = new();

    /// <summary>Each app's own integer id for it, so a caller can cross-check against the arr.</summary>
    public Dictionary<string, int> Ids { get; set; } = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Whether the profile upgrades an existing file when a better release appears.</summary>
    public bool UpgradeAllowed { get; set; }

    /// <summary>The quality (or quality group) name at which upgrading stops.</summary>
    public string Cutoff { get; set; } = string.Empty;

    /// <summary>Allowed qualities, best first, exactly as the app orders them.</summary>
    public List<QualityProfileItemView> Items { get; set; } = new();

    /// <summary>The default profile used when a title is added without naming one.</summary>
    public bool IsDefault { get; set; }

    /// <summary>
    /// Whether both apps agree about this profile.
    /// </summary>
    /// <remarks>
    /// False when only one app has it, or when the two disagree about the cutoff or the allowed
    /// set — which happens legitimately (a quality one app does not have) and illegitimately
    /// (somebody edited one app by hand). Either way the UI should say so rather than show one
    /// app's answer as if it were both.
    /// </remarks>
    public bool InSync { get; set; }

    /// <summary>Quality names the profile asked for that an app does not have, keyed by app.</summary>
    public Dictionary<string, List<string>> Unsupported { get; set; } = new(StringComparer.OrdinalIgnoreCase);
}

/// <summary>One quality, or one group of them, inside a profile.</summary>
public sealed class QualityProfileItemView
{
    /// <summary>The quality's name, e.g. <c>WEBDL-1080p</c>, or the group's, e.g. <c>WEB 1080p</c>.</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>Whether releases of this quality are accepted.</summary>
    public bool Allowed { get; set; }

    /// <summary>True when this is a group of interchangeable qualities rather than one quality.</summary>
    public bool IsGroup { get; set; }

    /// <summary>The group's members, empty for a plain quality.</summary>
    public List<QualityProfileItemView> Items { get; set; } = new();
}

/// <summary>The quality vocabulary each app has, so an editor can offer real choices.</summary>
public sealed class QualityVocabulary
{
    /// <summary>Quality and group names per app, in the app's own order, best first.</summary>
    public Dictionary<string, List<string>> Apps { get; set; } = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Names every configured app understands — the safe set for a shared profile.</summary>
    public List<string> Shared { get; set; } = new();
}

/// <summary>What a write did, per app.</summary>
public sealed class QualityProfileWriteResult
{
    /// <summary>The profile as it now stands, read back from the apps.</summary>
    public QualityProfileView? Profile { get; set; }

    /// <summary>One line per app: what was created, updated, deleted or refused.</summary>
    public List<string> Detail { get; set; } = new();

    /// <summary>False when at least one app refused.</summary>
    public bool Ok { get; set; }

    /// <summary>Why, when <see cref="Ok"/> is false.</summary>
    public string Message { get; set; } = string.Empty;
}

/// <summary>
/// Quality-profile CRUD across Radarr and Sonarr at once.
/// </summary>
/// <remarks>
/// Every write follows the same shape as <see cref="OmniarrSyncService"/>: fetch the app's own
/// schema, fill in what StingStream has an opinion about, post it back. The schema is what carries
/// each quality's integer id, its source and its resolution, none of which StingStream stores or
/// wants to.
/// </remarks>
public sealed class QualityProfileService
{
    private readonly ArrClientFactory _factory;
    private readonly Data.SettingsStore _settings;
    private readonly ILogger<QualityProfileService> _logger;

    public QualityProfileService(
        ArrClientFactory factory,
        Data.SettingsStore settings,
        ILogger<QualityProfileService> logger)
    {
        _factory = factory;
        _settings = settings;
        _logger = logger;
    }

    /// <summary>Every profile either app has, merged by name.</summary>
    public async Task<List<QualityProfileView>> ListAsync(CancellationToken ct = default)
    {
        var defaultName = _settings.Get().DefaultQualityProfileName;
        var byName = new Dictionary<string, QualityProfileView>(StringComparer.OrdinalIgnoreCase);
        var perApp = new Dictionary<string, Dictionary<string, JsonObject>>(StringComparer.OrdinalIgnoreCase);

        foreach (var client in _factory.CreateAll())
        {
            List<JsonObject> profiles;
            try
            {
                profiles = await client.QualityProfilesAsync(ct).ConfigureAwait(false);
            }
            catch (ArrApiException ex)
            {
                _logger.LogDebug(ex, "Could not read {App}'s quality profiles", client.Name);
                continue;
            }

            var appMap = new Dictionary<string, JsonObject>(StringComparer.OrdinalIgnoreCase);
            foreach (var raw in profiles)
            {
                var name = raw["name"]?.GetValue<string>();
                if (string.IsNullOrWhiteSpace(name))
                {
                    continue;
                }

                appMap[name] = raw;
                if (!byName.TryGetValue(name, out var view))
                {
                    view = new QualityProfileView { Name = name };
                    byName[name] = view;
                }

                view.Apps.Add(client.Name);
                if (raw["id"]?.GetValue<int>() is { } id)
                {
                    view.Ids[client.Name] = id;
                }

                // The first app to report a profile defines the view; the second is only compared
                // against it. Radarr comes first in CreateAll's stable order, so a mixed group
                // reads consistently rather than depending on which app answered faster.
                if (view.Items.Count == 0)
                {
                    view.UpgradeAllowed = raw["upgradeAllowed"]?.GetValue<bool>() ?? false;
                    view.Cutoff = CutoffName(raw);
                    view.Items = ReadItems(raw);
                }
            }

            perApp[client.Name] = appMap;
        }

        foreach (var view in byName.Values)
        {
            view.IsDefault = string.Equals(view.Name, defaultName, StringComparison.OrdinalIgnoreCase);
            view.InSync = view.Apps.Count > 1 && AppsAgree(view, perApp);
        }

        return byName.Values.OrderBy(v => v.Name, StringComparer.OrdinalIgnoreCase).ToList();
    }

    /// <summary>One profile by name, or null.</summary>
    public async Task<QualityProfileView?> GetAsync(string name, CancellationToken ct = default)
    {
        var all = await ListAsync(ct).ConfigureAwait(false);
        return all.FirstOrDefault(p => string.Equals(p.Name, name, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>What qualities each app understands.</summary>
    public async Task<QualityVocabulary> VocabularyAsync(CancellationToken ct = default)
    {
        var result = new QualityVocabulary();
        var sets = new List<HashSet<string>>();

        foreach (var client in _factory.CreateAll())
        {
            JsonObject? schema;
            try
            {
                schema = await client.QualityProfileSchemaAsync(ct).ConfigureAwait(false);
            }
            catch (ArrApiException ex)
            {
                _logger.LogDebug(ex, "Could not read {App}'s quality-profile schema", client.Name);
                continue;
            }

            if (schema is null)
            {
                continue;
            }

            var names = Flatten(ReadItems(schema)).ToList();
            result.Apps[client.Name] = names;
            sets.Add(new HashSet<string>(names, StringComparer.OrdinalIgnoreCase));
        }

        if (sets.Count > 0)
        {
            var shared = sets[0];
            foreach (var other in sets.Skip(1))
            {
                shared.IntersectWith(other);
            }

            // Ordered by the first app's own ordering rather than alphabetically: quality order is
            // meaningful (best first) and an alphabetical picker would be unreadable.
            var order = result.Apps.Values.FirstOrDefault() ?? new List<string>();
            result.Shared = order.Where(shared.Contains).ToList();
        }

        return result;
    }

    /// <summary>Create or replace a profile in both apps.</summary>
    /// <param name="desired">The profile, keyed on <see cref="QualityProfileView.Name"/>.</param>
    /// <param name="mustExist">True for an update: refuse when neither app has it.</param>
    /// <param name="ct">Cancellation token.</param>
    public async Task<QualityProfileWriteResult> SaveAsync(
        QualityProfileView desired,
        bool mustExist,
        CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(desired);
        var result = new QualityProfileWriteResult();

        var clients = _factory.CreateAll();
        if (clients.Count == 0)
        {
            result.Message = "No arr is configured on this node.";
            return result;
        }

        var allowed = new HashSet<string>(
            desired.Items.Where(i => i.Allowed).Select(i => i.Name),
            StringComparer.OrdinalIgnoreCase);
        if (allowed.Count == 0)
        {
            result.Message = "A quality profile must allow at least one quality.";
            return result;
        }

        var existedSomewhere = false;
        var wroteSomewhere = false;

        foreach (var client in clients)
        {
            try
            {
                var existing = await client.QualityProfileByNameAsync(desired.Name, ct).ConfigureAwait(false);
                existedSomewhere |= existing is not null;

                // The schema carries this app's complete quality tree with its real ids; the
                // existing profile carries the same shape, so an update edits what is there rather
                // than resetting fields StingStream has no opinion about (format scores, language).
                var basis = existing?.DeepClone().AsObject()
                    ?? await client.QualityProfileSchemaAsync(ct).ConfigureAwait(false);
                if (basis is null)
                {
                    result.Detail.Add($"{client.Name}: skipped (no quality-profile schema)");
                    continue;
                }

                var missing = Apply(basis, desired, allowed, out var cutoffFound);
                if (missing.Count > 0)
                {
                    desired.Unsupported[client.Name] = missing;
                }

                if (!cutoffFound)
                {
                    result.Detail.Add(
                        $"{client.Name}: cutoff \"{desired.Cutoff}\" is not one of its allowed qualities; "
                        + "used the lowest allowed one instead");
                }

                basis["name"] = desired.Name;
                basis["upgradeAllowed"] = desired.UpgradeAllowed;

                if (existing is null)
                {
                    basis["id"] = 0;
                    await client.PostAsync("qualityprofile", basis, ct).ConfigureAwait(false);
                    result.Detail.Add($"{client.Name}: created");
                }
                else
                {
                    var id = existing["id"]?.GetValue<int>() ?? 0;
                    basis["id"] = id;
                    await client
                        .PutAsync(
                            string.Create(CultureInfo.InvariantCulture, $"qualityprofile/{id}"),
                            basis,
                            ct)
                        .ConfigureAwait(false);
                    result.Detail.Add($"{client.Name}: updated");
                }

                wroteSomewhere = true;
            }
            catch (ArrApiException ex)
            {
                result.Detail.Add($"{client.Name}: {ArrClient.DescribeValidationFailure(ex.Body ?? ex.Message, System.Net.HttpStatusCode.BadRequest)}");
                _logger.LogWarning(ex, "Writing quality profile {Name} into {App} failed", desired.Name, client.Name);
            }
        }

        if (mustExist && !existedSomewhere)
        {
            result.Message = $"No app has a quality profile called \"{desired.Name}\".";
            return result;
        }

        result.Ok = wroteSomewhere;
        result.Profile = await GetAsync(desired.Name, ct).ConfigureAwait(false);
        if (!result.Ok)
        {
            result.Message = string.Join("; ", result.Detail);
        }

        return result;
    }

    /// <summary>Remove a profile from both apps.</summary>
    public async Task<QualityProfileWriteResult> DeleteAsync(string name, CancellationToken ct = default)
    {
        var result = new QualityProfileWriteResult();
        var found = false;

        foreach (var client in _factory.CreateAll())
        {
            try
            {
                var existing = await client.QualityProfileByNameAsync(name, ct).ConfigureAwait(false);
                if (existing is null)
                {
                    result.Detail.Add($"{client.Name}: not present");
                    continue;
                }

                found = true;
                var id = existing["id"]?.GetValue<int>() ?? 0;
                await client
                    .DeleteAsync(string.Create(CultureInfo.InvariantCulture, $"qualityprofile/{id}"), ct)
                    .ConfigureAwait(false);
                result.Detail.Add($"{client.Name}: deleted");
            }
            catch (ArrApiException ex)
            {
                // The usual refusal is "this profile is still in use by N titles", which is exactly
                // the sentence a user needs, so it is passed through rather than flattened.
                found = true;
                result.Detail.Add(
                    $"{client.Name}: {ArrClient.DescribeValidationFailure(ex.Body ?? ex.Message, System.Net.HttpStatusCode.BadRequest)}");
                result.Message = result.Detail[^1];
                _logger.LogWarning(ex, "Deleting quality profile {Name} from {App} failed", name, client.Name);
                return result;
            }
        }

        result.Ok = found;
        if (!found)
        {
            result.Message = $"No app has a quality profile called \"{name}\".";
        }

        return result;
    }

    // --- mapping -----------------------------------------------------------

    /// <summary>
    /// Set <c>allowed</c> and <c>cutoff</c> on one app's profile resource from the shared model.
    /// </summary>
    /// <returns>The quality names the shared model asked for that this app does not have.</returns>
    public static List<string> Apply(
        JsonObject resource,
        QualityProfileView desired,
        HashSet<string> allowed,
        out bool cutoffFound)
    {
        cutoffFound = false;
        var known = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        int? cutoffId = null;
        int? lowestAllowedId = null;

        if (resource["items"] is JsonArray items)
        {
            foreach (var item in items.OfType<JsonObject>())
            {
                var name = ItemName(item);
                if (string.IsNullOrEmpty(name))
                {
                    continue;
                }

                known.Add(name);
                var isAllowed = allowed.Contains(name);

                // A group is allowed when the group itself is named, or when any member is: the
                // shared model's checkbox list is flat, and a user ticking "WEBDL-1080p" inside
                // Radarr's "WEB 1080p" group means the group. Membership is therefore read in full
                // *before* anything is written -- writing as we go would leave every member before
                // the one that flipped the group carrying the wrong value.
                var members = item["items"] as JsonArray;
                if (members is { Count: > 0 })
                {
                    foreach (var memberName in members.OfType<JsonObject>().Select(ItemName))
                    {
                        if (string.IsNullOrEmpty(memberName))
                        {
                            continue;
                        }

                        known.Add(memberName);
                        if (allowed.Contains(memberName))
                        {
                            isAllowed = true;
                        }
                    }

                    // NzbDrone requires every member of an allowed group to be allowed too; a group
                    // with a disallowed member fails validation.
                    foreach (var member in members.OfType<JsonObject>())
                    {
                        member["allowed"] = isAllowed;
                    }
                }

                item["allowed"] = isAllowed;

                // The cutoff is an id: a group's own id when it is a group, the quality's when not.
                var id = GroupOrQualityId(item);
                if (id is null)
                {
                    continue;
                }

                if (isAllowed)
                {
                    // "items" is ordered best first, so the last allowed one is the lowest.
                    lowestAllowedId = id;
                    if (string.Equals(name, desired.Cutoff, StringComparison.OrdinalIgnoreCase))
                    {
                        cutoffId = id;
                        cutoffFound = true;
                    }
                }
            }
        }

        // A cutoff that is not allowed is rejected outright by both apps, so falling back to the
        // lowest allowed quality is the only answer that stores at all -- and it is also the one
        // that behaves like "no cutoff", which is what a user who did not set one means.
        resource["cutoff"] = cutoffId ?? lowestAllowedId;

        return allowed.Where(a => !known.Contains(a)).OrderBy(a => a, StringComparer.Ordinal).ToList();
    }

    private static string ItemName(JsonObject item)
        => item["name"]?.GetValue<string>()
            ?? (item["quality"] as JsonObject)?["name"]?.GetValue<string>()
            ?? string.Empty;

    private static int? GroupOrQualityId(JsonObject item)
        => item["id"]?.GetValue<int>() ?? (item["quality"] as JsonObject)?["id"]?.GetValue<int>();

    private static List<QualityProfileItemView> ReadItems(JsonObject resource)
    {
        var result = new List<QualityProfileItemView>();
        if (resource["items"] is not JsonArray items)
        {
            return result;
        }

        foreach (var item in items.OfType<JsonObject>())
        {
            var name = ItemName(item);
            if (string.IsNullOrEmpty(name))
            {
                continue;
            }

            var view = new QualityProfileItemView
            {
                Name = name,
                Allowed = item["allowed"]?.GetValue<bool>() ?? false,
            };

            if (item["items"] is JsonArray members && members.Count > 0)
            {
                view.IsGroup = true;
                foreach (var member in members.OfType<JsonObject>())
                {
                    var memberName = ItemName(member);
                    if (string.IsNullOrEmpty(memberName))
                    {
                        continue;
                    }

                    view.Items.Add(new QualityProfileItemView
                    {
                        Name = memberName,
                        Allowed = member["allowed"]?.GetValue<bool>() ?? false,
                    });
                }
            }

            result.Add(view);
        }

        return result;
    }

    /// <summary>Every name in an item tree, groups and their members alike.</summary>
    public static IEnumerable<string> Flatten(IEnumerable<QualityProfileItemView> items)
    {
        foreach (var item in items)
        {
            yield return item.Name;
            foreach (var member in item.Items)
            {
                yield return member.Name;
            }
        }
    }

    private static string CutoffName(JsonObject profile)
    {
        var cutoff = profile["cutoff"]?.GetValue<int>();
        if (cutoff is null || profile["items"] is not JsonArray items)
        {
            return string.Empty;
        }

        foreach (var item in items.OfType<JsonObject>())
        {
            if (GroupOrQualityId(item) == cutoff)
            {
                return ItemName(item);
            }

            if (item["items"] is JsonArray members)
            {
                foreach (var member in members.OfType<JsonObject>())
                {
                    if (GroupOrQualityId(member) == cutoff)
                    {
                        return ItemName(member);
                    }
                }
            }
        }

        return string.Empty;
    }

    /// <summary>True when every app holding this profile stores the same cutoff and allowed set.</summary>
    private static bool AppsAgree(
        QualityProfileView view,
        Dictionary<string, Dictionary<string, JsonObject>> perApp)
    {
        string? cutoff = null;
        HashSet<string>? allowed = null;

        foreach (var app in view.Apps)
        {
            if (!perApp.TryGetValue(app, out var profiles) || !profiles.TryGetValue(view.Name, out var raw))
            {
                return false;
            }

            var thisCutoff = CutoffName(raw);
            var thisAllowed = new HashSet<string>(
                Flatten(ReadItems(raw).Where(i => i.Allowed)),
                StringComparer.OrdinalIgnoreCase);

            if (cutoff is null)
            {
                cutoff = thisCutoff;
                allowed = thisAllowed;
                continue;
            }

            if (!string.Equals(cutoff, thisCutoff, StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            if (allowed is not null && !allowed.SetEquals(thisAllowed))
            {
                return false;
            }
        }

        return true;
    }
}
