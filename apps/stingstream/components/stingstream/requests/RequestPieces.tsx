import { Image } from "expo-image";
import { TouchableOpacity, View } from "react-native";
import { Text } from "@/components/common/Text";
import {
  type MemberRequest,
  type RequestState,
  requestTitle,
  seasonsLabel,
  stateLabel,
  stateTone,
} from "@/lib/stingstream/requestsApi";

/**
 * The small parts every Requests section draws: a state pill, a poster, a row, and a button.
 *
 * Kept together rather than one file each because each is a dozen lines and they are only ever
 * used by the four sections in this folder. The presentation *rules* they depend on — what a state
 * is called, what tone it gets, how seasons read — live in `lib/stingstream/requestsApi.ts` with
 * the rest of the pure logic, so they are covered by `requestsApi.test.ts` rather than by nothing.
 */

const TONE_STYLES: Record<
  ReturnType<typeof stateTone>,
  { background: string; text: string }
> = {
  waiting: { background: "#3a3320", text: "#F5C451" },
  working: { background: "#1e3350", text: "#5FA8FF" },
  done: { background: "#1d3626", text: "#5FD08A" },
  stopped: { background: "#3a2222", text: "#FF6B6B" },
};

/** The state, in the words a member would use, in the colour of what it means. */
export function StatePill({ state }: { state: RequestState }) {
  const tone = TONE_STYLES[stateTone(state)];
  return (
    <View
      className='rounded-full px-2 py-0.5 self-start'
      style={{ backgroundColor: tone.background }}
    >
      <Text className='text-[11px] font-semibold' style={{ color: tone.text }}>
        {stateLabel(state)}
      </Text>
    </View>
  );
}

/**
 * A poster, or a lettered placeholder when the metadata lookup had none.
 *
 * The URL is TMDB's or TheTVDB's own CDN (the arr lookup's `remoteUrl`), not something this node
 * serves, so it goes through a plain `Image` rather than `ServerImage` — there is no Jellyfin token
 * to attach and attaching one would leak it to a third party.
 */
export function Poster({
  url,
  title,
  size = 56,
}: {
  url?: string | null;
  title: string;
  size?: number;
}) {
  const height = Math.round(size * 1.5);
  if (!url) {
    return (
      <View
        className='rounded-md bg-neutral-800 items-center justify-center'
        style={{ width: size, height }}
      >
        <Text className='text-[#6b6b70] text-lg font-semibold'>
          {(title.trim()[0] ?? "?").toUpperCase()}
        </Text>
      </View>
    );
  }

  return (
    <Image
      source={{ uri: url }}
      contentFit='cover'
      transition={120}
      style={{ width: size, height, borderRadius: 6 }}
    />
  );
}

/** A filled or outlined button, sized for a list row rather than a form. */
export function RowButton({
  label,
  onPress,
  tone = "primary",
  disabled = false,
}: {
  label: string;
  onPress?: () => void;
  tone?: "primary" | "quiet" | "danger";
  disabled?: boolean;
}) {
  const background =
    tone === "primary" ? "#9334E9" : tone === "danger" ? "#3a2222" : "#262626";
  const colour = tone === "danger" ? "#FF6B6B" : "#FFFFFF";
  return (
    <TouchableOpacity
      accessibilityRole='button'
      disabled={disabled || !onPress}
      onPress={onPress}
      className='rounded-lg px-3 py-2'
      style={{ backgroundColor: background, opacity: disabled ? 0.45 : 1 }}
    >
      <Text className='text-xs font-semibold' style={{ color: colour }}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

/**
 * One request, as every list draws it.
 *
 * The note is shown, not hidden behind a tap. It is the sentence the node wrote about *why* the
 * request is where it is — "loft is grabbing it", "already in the group, held by attic; nothing was
 * downloaded" — and it is the whole reason a request that starts no download does not look broken.
 */
export function RequestRow({
  request,
  actions,
  onPress,
}: {
  request: MemberRequest;
  actions?: React.ReactNode;
  onPress?: () => void;
}) {
  const body = (
    <View className='flex-row gap-3 p-3'>
      <Poster url={request.posterUrl} title={request.title} />
      <View className='flex-1'>
        <Text className='text-white font-semibold' numberOfLines={2}>
          {requestTitle(request)}
        </Text>
        <View className='flex-row items-center gap-2 mt-1'>
          <StatePill state={request.state} />
          {request.kind === "series" && (
            <Text className='text-[#9899A1] text-[11px]'>
              {seasonsLabel(request.seasons)}
            </Text>
          )}
        </View>
        {request.note ? (
          <Text className='text-[#9899A1] text-xs mt-1' numberOfLines={3}>
            {request.note}
          </Text>
        ) : null}
        <Text className='text-[#5A5960] text-[11px] mt-1'>
          Asked by {request.requestedByName || "someone"}
        </Text>
        {actions ? (
          <View className='flex-row gap-2 mt-2'>{actions}</View>
        ) : null}
      </View>
    </View>
  );

  if (!onPress) {
    return <View className='rounded-xl bg-neutral-900 mb-2'>{body}</View>;
  }

  return (
    <TouchableOpacity
      className='rounded-xl bg-neutral-900 mb-2'
      onPress={onPress}
    >
      {body}
    </TouchableOpacity>
  );
}
