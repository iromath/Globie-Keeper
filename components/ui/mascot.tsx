import { useEffect, useId, useState } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import Animated, {
    Easing,
    interpolate,
    useAnimatedStyle,
    useSharedValue,
    withRepeat,
    withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, ClipPath, Defs, Ellipse, G, Path } from 'react-native-svg';

import { colors } from './theme';

/**
 * Baby Kae Na — the Globie Earth mascot. She is drawn, not photographed: the
 * whole character is vector art so she stays crisp from a 24px feed avatar to a
 * 160px celebration, themes with the palette below, and can be animated with
 * transforms instead of a sprite sheet.
 *
 * Art direction: a mint seed pod with a crown of white trumpet blooms, a leaf
 * ruff at the neck, and a kawaii face. The outline is one dark ink so the shape
 * survives on both graphite and accent surfaces.
 */

const INK = '#0E211A';
const MINT = '#8FE3B4';
const MINT_DEEP = '#68CE9B';
const LEAF = '#79D79C';
const LEAF_DEEP = '#4FB97C';
const CREAM = '#FBEBCB';
const PETAL = '#FFFFFF';
const STAMEN = '#F2B43C';
const BLUSH = '#F49C9C';
const MOUTH = '#7C2B39';
const TONGUE = '#F58C9B';

/** Full-body composition, the bust crop, and the tight badge crop for tiny slots. */
const FULL_BOX = '0 0 200 220';
const FACE_BOX = '14 8 172 172';
const BADGE_BOX = '44 62 112 112';

type Mood = 'idle' | 'cheer';

type Props = {
  /** Width. A full-body drawing is 1.1× as tall; the cropped variants are square. */
  size?: number;
  variant?: 'full' | 'face' | 'badge';
  mood?: Mood;
  /** The little gold stars. Off inside dense rows. */
  sparkles?: boolean;
  /** A halo ring that keeps escaping behind her — the "you earned something" beat. */
  halo?: boolean;
  /** Accessible name. Pass `null` when the drawing is decorative. */
  label?: string | null;
  style?: ViewStyle;
};

export function BabyKaeNa({
  size = 96,
  variant = 'full',
  mood = 'idle',
  sparkles = true,
  halo = false,
  label = 'Baby Kae Na, the Globie Keeper mascot',
  style,
}: Props) {
  const bust = variant !== 'full';
  const badge = variant === 'badge';
  const box = badge ? BADGE_BOX : bust ? FACE_BOX : FULL_BOX;
  const height = bust ? size : Math.round(size * 1.1);
  const clipId = `kae-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

  const bob = useSharedValue(0);
  const sway = useSharedValue(0);
  const shine = useSharedValue(0);
  const ring = useSharedValue(0);
  const [blink, setBlink] = useState(false);

  useEffect(() => {
    const cheer = mood === 'cheer';
    bob.value = withRepeat(
      withTiming(1, { duration: cheer ? 520 : 2400, easing: Easing.inOut(Easing.quad) }),
      -1,
      true
    );
    sway.value = withRepeat(
      withTiming(1, { duration: cheer ? 1300 : 3800, easing: Easing.inOut(Easing.sin) }),
      -1,
      true
    );
    shine.value = withRepeat(
      withTiming(1, { duration: cheer ? 900 : 2200, easing: Easing.inOut(Easing.quad) }),
      -1,
      true
    );
    ring.value = halo
      ? withRepeat(withTiming(1, { duration: 1800, easing: Easing.out(Easing.quad) }), -1, false)
      : 0;
  }, [bob, sway, shine, ring, mood, halo]);

  // A blink every few seconds. Two intervals, so the blink itself is a short beat.
  useEffect(() => {
    let shut: ReturnType<typeof setTimeout> | undefined;
    const open = setInterval(() => {
      setBlink(true);
      shut = setTimeout(() => setBlink(false), 150);
    }, 4200);
    return () => {
      clearInterval(open);
      if (shut) clearTimeout(shut);
    };
  }, []);

  const bodyStyle = useAnimatedStyle(() => {
    const lift = mood === 'cheer' ? 9 : 5;
    return {
      transform: [
        { translateY: interpolate(bob.value, [0, 1], [0, -(size * lift) / 100]) },
        { rotate: `${interpolate(sway.value, [0, 1], [-2.4, 2.4])}deg` },
        { scale: mood === 'cheer' ? interpolate(bob.value, [0, 1], [1, 1.035]) : 1 },
      ],
    };
  }, [size, mood]);

  const sparkleStyle = useAnimatedStyle(() => ({
    opacity: interpolate(shine.value, [0, 1], [0.35, 1]),
    transform: [
      { rotate: `${interpolate(shine.value, [0, 1], [-7, 7])}deg` },
      { scale: interpolate(shine.value, [0, 1], [0.92, 1.08]) },
    ],
  }));

  const ringStyle = useAnimatedStyle(() => ({
    opacity: interpolate(ring.value, [0, 0.6, 1], [0.34, 0.08, 0]),
    transform: [{ scale: interpolate(ring.value, [0, 1], [0.82, 1.42]) }],
  }));

  return (
    <View
      style={[{ width: size, height }, style]}
      accessibilityRole={label ? 'image' : undefined}
      accessibilityLabel={label ?? undefined}
      aria-hidden={label ? undefined : true}
    >
      {halo ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.ring,
            { width: height, height: height, borderRadius: height / 2 },
            ringStyle,
          ]}
        />
      ) : null}

      <Animated.View style={[StyleSheet.absoluteFill, bodyStyle]}>
        <Svg viewBox={box} width="100%" height="100%">
          <Defs>
            <ClipPath id={clipId}>
              <Circle cx={100} cy={94} r={86} />
            </ClipPath>
          </Defs>
          <G clipPath={bust ? `url(#${clipId})` : undefined}>
            <Art blink={blink} ground={!bust} bust={bust} badge={badge} />
          </G>
        </Svg>
      </Animated.View>

      {sparkles && !badge ? (
        <Animated.View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, sparkleStyle]}
        >
          <Svg viewBox={box} width="100%" height="100%">
            <Sparkles bust={bust} />
          </Svg>
        </Animated.View>
      ) : null}
    </View>
  );
}

/** The character, assembled back-to-front so overlaps read like cel animation. */
function Art({
  blink,
  ground,
  bust,
  badge,
}: {
  blink: boolean;
  ground: boolean;
  bust: boolean;
  badge: boolean;
}) {
  return (
    <>
      {ground ? <Ellipse cx={100} cy={203} rx={44} ry={7} fill="#000" opacity={0.32} /> : null}

      {badge ? null : (
        <>
          <Stems />
          <G>
            <Bloom x={44} y={90} scale={0.86} tilt={-18} />
            <Bloom x={156} y={90} scale={0.86} tilt={18} />
            <Bloom x={68} y={58} scale={0.92} tilt={-10} />
            <Bloom x={132} y={58} scale={0.92} tilt={10} />
            <Bloom x={100} y={46} scale={1} tilt={0} />
          </G>
        </>
      )}

      {bust ? null : (
        <>
          <Arm d="M66 138 C 48 142 38 152 33 164" hand={{ x: 32, y: 166, rotate: -20 }} />
          <Arm d="M134 136 C 154 137 167 133 171 125" hand={{ x: 171, y: 123, rotate: 160 }} />

          <Ellipse cx={84} cy={197} rx={12} ry={8} fill={MINT} stroke={INK} strokeWidth={4} />
          <Ellipse cx={116} cy={197} rx={12} ry={8} fill={MINT} stroke={INK} strokeWidth={4} />
        </>
      )}

      <Path
        d="M100 84 C 74 84 58 106 56 140 C 54 174 74 196 100 196 C 126 196 146 174 144 140 C 142 106 126 84 100 84 Z"
        fill={MINT}
        stroke={INK}
        strokeWidth={5}
        strokeLinejoin="round"
      />
      <Path
        d="M100 100 L100 190"
        stroke={MINT_DEEP}
        strokeWidth={2.6}
        strokeLinecap="round"
        opacity={0.85}
      />
      <Path
        d="M84 110 C 76 126 74 146 78 164"
        stroke="#FFFFFF"
        strokeWidth={7}
        strokeLinecap="round"
        opacity={0.26}
        fill="none"
      />

      <Leaf x={100} y={100} rotate={-64} scale={0.86} />
      <Leaf x={100} y={100} rotate={-32} scale={0.94} deep />
      <Leaf x={100} y={100} rotate={0} scale={1} />
      <Leaf x={100} y={100} rotate={32} scale={0.94} deep />
      <Leaf x={100} y={100} rotate={64} scale={0.86} />

      <Face blink={blink} />
    </>
  );
}

function Stems() {
  const stems = [
    'M100 104 C 100 84 100 62 100 46',
    'M94 104 C 84 88 74 70 68 58',
    'M106 104 C 116 88 126 70 132 58',
    'M88 106 C 70 102 54 96 44 90',
    'M112 106 C 130 102 146 96 156 90',
  ];
  return (
    <>
      <G stroke={INK} strokeWidth={10} strokeLinecap="round" fill="none">
        {stems.map((d) => (
          <Path key={d} d={d} />
        ))}
      </G>
      <G stroke="#F7E8C8" strokeWidth={6} strokeLinecap="round" fill="none">
        {stems.map((d) => (
          <Path key={d} d={d} />
        ))}
      </G>
    </>
  );
}

type BloomProps = { x: number; y: number; scale?: number; tilt?: number };

/** Five white petals around a cream trumpet with a gold stamen. */
function Bloom({ x, y, scale = 1, tilt = 0 }: BloomProps) {
  return (
    <G transform={`translate(${x} ${y}) rotate(${tilt}) scale(${scale})`}>
      {[0, 72, 144, 216, 288].map((angle) => (
        <Path
          key={angle}
          d="M0 -5 C -9 -13 -11 -24 0 -31 C 11 -24 9 -13 0 -5 Z"
          fill={PETAL}
          stroke={INK}
          strokeWidth={3}
          strokeLinejoin="round"
          transform={`rotate(${angle})`}
        />
      ))}
      <Circle cx={0} cy={0} r={10.5} fill={CREAM} stroke={INK} strokeWidth={3} />
      <Circle cx={0} cy={-1} r={4.6} fill={STAMEN} />
      <Circle cx={-5} cy={4} r={1.6} fill={STAMEN} />
      <Circle cx={5} cy={4} r={1.6} fill={STAMEN} />
    </G>
  );
}

type LeafProps = { x: number; y: number; rotate?: number; scale?: number; deep?: boolean };

function Leaf({ x, y, rotate = 0, scale = 1, deep = false }: LeafProps) {
  return (
    <G transform={`translate(${x} ${y}) rotate(${rotate}) scale(${scale})`}>
      <Path
        d="M0 0 C -11 -8 -13 -25 0 -38 C 13 -25 11 -8 0 0 Z"
        fill={deep ? LEAF_DEEP : LEAF}
        stroke={INK}
        strokeWidth={3}
        strokeLinejoin="round"
      />
      <Path d="M0 -4 L0 -30" stroke={INK} strokeWidth={1.6} strokeLinecap="round" opacity={0.3} />
    </G>
  );
}

type ArmProps = { d: string; hand: { x: number; y: number; rotate: number } };

function Arm({ d, hand }: ArmProps) {
  return (
    <G>
      <Path d={d} stroke={INK} strokeWidth={19} strokeLinecap="round" fill="none" />
      <Path d={d} stroke={MINT_DEEP} strokeWidth={12} strokeLinecap="round" fill="none" />
      <G transform={`translate(${hand.x} ${hand.y}) rotate(${hand.rotate})`}>
        <Path
          d="M-8 2 C -12 -4 -8 -12 0 -12 C 8 -12 12 -4 8 2 C 5 7 -5 7 -8 2 Z"
          fill={MINT}
          stroke={INK}
          strokeWidth={3.5}
          strokeLinejoin="round"
        />
      </G>
    </G>
  );
}

function Face({ blink }: { blink: boolean }) {
  return (
    <G>
      <G stroke={INK} strokeWidth={3.4} strokeLinecap="round" fill="none" opacity={0.9}>
        <Path d="M71 121 Q 81 114 91 120" />
        <Path d="M109 120 Q 119 114 129 121" />
      </G>

      {blink ? (
        <G stroke={INK} strokeWidth={5} strokeLinecap="round" fill="none">
          <Path d="M72 141 Q 82 149 92 141" />
          <Path d="M108 141 Q 118 149 128 141" />
        </G>
      ) : (
        <>
          <Ellipse cx={82} cy={140} rx={9.5} ry={12} fill="#12211B" />
          <Circle cx={79} cy={135.5} r={3.4} fill="#FFFFFF" />
          <Circle cx={86} cy={144.5} r={1.5} fill="#FFFFFF" opacity={0.7} />
          <Ellipse cx={118} cy={140} rx={9.5} ry={12} fill="#12211B" />
          <Circle cx={115} cy={135.5} r={3.4} fill="#FFFFFF" />
          <Circle cx={122} cy={144.5} r={1.5} fill="#FFFFFF" opacity={0.7} />
        </>
      )}

      <Ellipse cx={68} cy={158} rx={9} ry={5} fill={BLUSH} opacity={0.55} />
      <Ellipse cx={132} cy={158} rx={9} ry={5} fill={BLUSH} opacity={0.55} />

      <Path
        d="M89 152 Q 100 147 111 152 Q 109 169 100 169 Q 91 169 89 152 Z"
        fill={MOUTH}
        stroke={INK}
        strokeWidth={3.4}
        strokeLinejoin="round"
      />
      <Ellipse cx={100} cy={165} rx={5.6} ry={3.4} fill={TONGUE} />
    </G>
  );
}

/**
 * Her signature sparkle layer: gold stars and mint motes, on their own transform.
 * The bust crop has its own positions so nothing is clipped by the face box.
 */
function Sparkles({ bust }: { bust: boolean }) {
  if (bust) {
    return (
      <>
        <Star x={34} y={148} size={9} fill={colors.hero} />
        <Star x={166} y={120} size={6.5} fill={colors.accent} />
        <Star x={156} y={164} size={5} fill={colors.hero} />
        <Circle cx={44} cy={112} r={2.4} fill={colors.accent} opacity={0.85} />
        <Circle cx={160} cy={142} r={2} fill={colors.hero} opacity={0.85} />
      </>
    );
  }

  return (
    <>
      <Star x={26} y={118} size={12} fill={colors.hero} />
      <Star x={28} y={94} size={5.5} fill={colors.accent} />
      <Star x={174} y={150} size={8.5} fill={colors.accent} />
      <Star x={152} y={194} size={6} fill={colors.hero} />
      <Circle cx={44} cy={142} r={2.6} fill={colors.accent} opacity={0.85} />
      <Circle cx={168} cy={124} r={2} fill={colors.hero} opacity={0.85} />
    </>
  );
}

function Star({ x, y, size, fill }: { x: number; y: number; size: number; fill: string }) {
  const d = `M0 ${-size} Q ${size * 0.22} ${-size * 0.22} ${size} 0 Q ${size * 0.22} ${
    size * 0.22
  } 0 ${size} Q ${-size * 0.22} ${size * 0.22} ${-size} 0 Q ${-size * 0.22} ${-size * 0.22} 0 ${-size} Z`;
  return <Path d={d} fill={fill} transform={`translate(${x} ${y})`} />;
}

const styles = StyleSheet.create({
  ring: {
    position: 'absolute',
    alignSelf: 'center',
    backgroundColor: colors.accent,
  },
});
