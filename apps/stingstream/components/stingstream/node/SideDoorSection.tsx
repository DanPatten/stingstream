import { useCallback, useState } from "react";
import { View } from "react-native";
import { Button } from "@/components/Button";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { useNodeMeshStatus } from "@/lib/stingstream/mesh";
import {
  candidatesToTry,
  diagnoseRebinding,
  type ProbeOutcome,
  pickWinner,
  plainLanFallback,
  probeCandidate,
  REBINDING_WARNING,
  type SideDoorRecord,
} from "@/lib/stingstream/sidedoor";

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
        <Text className='text-white text-lg font-semibold mb-2'>
          Remote access (side door)
        </Text>
        <View className='rounded-xl bg-neutral-900 p-4'>
          <Text className='text-white font-semibold'>
            No side door configured
          </Text>
          <Text className='text-[#9899A1] text-xs mt-1'>
            {record?.zone
              ? "This node's coordinator has a zone but has not published this node's names yet — check back shortly."
              : "This node has no coordinator with a side-door zone, so there is nothing to test. This is the zero-server default, not an error: the app still reaches this node over the mesh. See docs/SIDEDOOR.md."}
          </Text>
        </View>
      </View>
    );
  }

  const winner = state === "done" ? pickWinner(outcomes) : null;
  const rebinding = state === "done" ? diagnoseRebinding(outcomes) : null;

  return (
    <View>
      <Text className='text-white text-lg font-semibold mb-2'>
        Remote access (side door)
      </Text>
      <ListGroup>
        <ListItem title='Zone' value={record.zone ?? "unknown"} />
        <ListItem title='Coordinator' value={record.coordinator ?? "unknown"} />
        <ListItem
          title='Public reachability'
          value={record.direct_https ?? "unknown"}
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
                      ? `reachable · ${o.ms} ms${winner?.candidate.kind === c.kind ? " · would be used" : ""}`
                      : `unreachable${o.error ? ` · ${o.error}` : ""}`;
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

      <View className='mt-3'>
        <Button onPress={runTest} disabled={state === "testing"} color='purple'>
          {state === "testing" ? "Testing…" : "Test connection"}
        </Button>
      </View>

      {state === "done" && rebinding?.rebinding && (
        <View className='mt-3 p-3 rounded-xl bg-amber-950 border border-amber-700'>
          <Text className='text-amber-200 font-semibold mb-1'>
            DNS rebinding protection detected
          </Text>
          <Text className='text-amber-100 text-sm'>{REBINDING_WARNING}</Text>
          {(() => {
            const fallback = plainLanFallback(record);
            return fallback ? (
              <Text className='text-amber-100 text-sm mt-2'>
                Plain-HTTP LAN fallback: {fallback.url}
              </Text>
            ) : null;
          })()}
        </View>
      )}

      {state === "done" && !rebinding?.rebinding && winner && (
        <Text className='text-[#9899A1] text-xs mt-3'>
          A real connection from this device would use {winner.candidate.kind} (
          {winner.ms} ms).
        </Text>
      )}

      {state === "done" && !winner && (
        <Text className='text-red-400 text-xs mt-3'>
          Nothing answered — this node is not reachable from here over any
          side-door candidate right now.
        </Text>
      )}
    </View>
  );
}
