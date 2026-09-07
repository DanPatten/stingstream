import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { Button } from "@/components/Button";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { radius, rgba, tokens } from "@/constants/theme";
import { useNodeMeshStatus } from "@/lib/stingstream/mesh";
import {
  candidatesToTry,
  diagnoseRebinding,
  type ProbeOutcome,
  pickWinner,
  plainLanFallback,
  probeCandidate,
  type SideDoorRecord,
} from "@/lib/stingstream/sidedoor";
import { ScreenHeaderRow } from "../shared/ScreenHeaderRow";

/**
 * DNS-rebinding detection on Node status (M5 deliverable 5).
 *
 * Some routers (OpenWrt's dnsmasq, pfSense, Fritz!Box) refuse to answer a public DNS name with a
 * private address, which breaks `lan.<nodeid>` specifically — the signature is exact: the LAN
 * *hostname* fails while the LAN *address* answers (`docs/SIDEDOOR.md` §5, `diagnoseRebinding`).
 * Ordinary side-door racing (`lib/stingstream/castStreamUrl.ts`, the web bundle) only surfaces
 * this when the plain-HTTP fallback actually *wins* a race — which it does not when `pub` or
 * `relay` also happen to work, so a rebinding router can go unnoticed by a user who never sees the
 * warning even though their LAN connections keep needlessly leaving the LAN. This section runs a
 * dedicated test that probes every candidate on its own, independent of which one a real
 * connection would pick, so the diagnosis is visible either way.
 */

type CandidateState = "idle" | "testing" | "done";

export function SideDoorSection() {
  const { t } = useTranslation();
  const status = useNodeMeshStatus();
  const [state, setState] = useState<CandidateState>("idle");
  const [outcomes, setOutcomes] = useState<ProbeOutcome[]>([]);

  const record: SideDoorRecord | null | undefined = status.data?.sideDoor;

  const runTest = useCallback(async () => {
    if (!record) return;
    setState("testing");
    const candidates = candidatesToTry(record);
    const fallback = plainLanFallback(record);
    const all = fallback ? [...candidates, fallback] : candidates;
    const results = await Promise.all(
      all.map((c) => probeCandidate(c, record.node, { timeoutMs: 4000 })),
    );
    setOutcomes(results);
    setState("done");
  }, [record]);

  if (status.isLoading) return null;

  if (!record || record.candidates.length === 0) {
    return (
      <View>
        <ScreenHeaderRow title={t("server_status.side_door_title")} />
        <View
          style={{
            borderRadius: radius.md,
            backgroundColor: tokens.color.bg["1"],
            padding: 16,
          }}
        >
          <Text weight='semibold'>
            {t("server_status.side_door_none_title")}
          </Text>
          <Text variant='caption' tone='secondary' style={{ marginTop: 4 }}>
            {record?.zone
              ? t("server_status.side_door_zone_pending_detail")
              : t("server_status.side_door_no_coordinator_detail")}
          </Text>
        </View>
      </View>
    );
  }

  const winner = state === "done" ? pickWinner(outcomes) : null;
  const rebinding = state === "done" ? diagnoseRebinding(outcomes) : null;

  return (
    <View>
      <ScreenHeaderRow title={t("server_status.side_door_title")} />
      <ListGroup>
        <ListItem
          title={t("server_status.side_door_zone_field")}
          value={record.zone ?? t("server_status.unknown")}
        />
        <ListItem
          title={t("server_status.rendezvous_server_field")}
          value={record.coordinator ?? t("server_status.unknown")}
        />
        <ListItem
          title={t("server_status.public_reachability_field")}
          value={record.direct_https ?? t("server_status.unknown")}
          textColor={record.direct_https === "blocked" ? "red" : "default"}
        />
        {record.candidates.map((c) => (
          <ListItem
            key={c.kind}
            title={c.kind}
            value={c.host}
            subtitle={
              state === "done"
                ? (() => {
                    const o = outcomes.find((x) => x.candidate.kind === c.kind);
                    if (!o) return undefined;
                    return o.ok
                      ? t("server_status.side_door_reachable", {
                          ms: o.ms,
                          winner:
                            winner?.candidate.kind === c.kind
                              ? t("server_status.side_door_would_be_used")
                              : "",
                        })
                      : t("server_status.side_door_unreachable", {
                          error: o.error ? ` · ${o.error}` : "",
                        });
                  })()
                : undefined
            }
            textColor={
              state === "done" &&
              outcomes.find((x) => x.candidate.kind === c.kind)?.ok === false
                ? "red"
                : "default"
            }
          />
        ))}
      </ListGroup>

      <View style={{ marginTop: 12 }}>
        <Button onPress={() => void runTest()} disabled={state === "testing"}>
          {state === "testing"
            ? t("server_status.side_door_testing")
            : t("server_status.side_door_test_action")}
        </Button>
      </View>

      {state === "done" && rebinding?.rebinding && (
        <View
          style={{
            marginTop: 12,
            padding: 12,
            borderRadius: radius.md,
            backgroundColor: rgba(tokens.color.state.warning, 0.14),
            borderWidth: 1,
            borderColor: rgba(tokens.color.state.warning, 0.4),
          }}
        >
          <Text weight='semibold' style={{ color: tokens.color.state.warning }}>
            {t("server_status.side_door_rebinding_title")}
          </Text>
          <Text
            variant='caption'
            style={{ color: tokens.color.state.warning, marginTop: 4 }}
          >
            {t("server_status.side_door_rebinding_detail")}
          </Text>
          {(() => {
            const fallback = plainLanFallback(record);
            return fallback ? (
              <Text
                variant='caption'
                style={{ color: tokens.color.state.warning, marginTop: 8 }}
              >
                {t("server_status.side_door_plain_fallback", {
                  url: fallback.url,
                })}
              </Text>
            ) : null;
          })()}
        </View>
      )}

      {state === "done" && !rebinding?.rebinding && winner && (
        <Text variant='caption' tone='secondary' style={{ marginTop: 12 }}>
          {t("server_status.side_door_would_use", {
            kind: winner.candidate.kind,
            ms: winner.ms,
          })}
        </Text>
      )}

      {state === "done" && !winner && (
        <Text variant='caption' tone='danger' style={{ marginTop: 12 }}>
          {t("server_status.side_door_nothing_answered")}
        </Text>
      )}
    </View>
  );
}
