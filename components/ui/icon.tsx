import Ionicons from '@react-native-vector-icons/ionicons';
import type { ComponentProps } from 'react';

import { colors } from './theme';

export type IconName = ComponentProps<typeof Ionicons>['name'];

/**
 * The app's icon vocabulary in one place, so a meaning keeps one glyph and a
 * screen never reaches past this map for a raw Ionicons name. The `*Outline`
 * pair is the unfilled variant: filled reads as "active", outline as "at rest".
 */
export const icon = {
  home: 'home',
  homeOutline: 'home-outline',
  shares: 'wallet',
  sharesOutline: 'wallet-outline',
  activity: 'pulse',
  activityOutline: 'pulse-outline',

  receipt: 'receipt',
  receiptOutline: 'receipt-outline',
  camera: 'camera',
  cameraOutline: 'camera-outline',
  images: 'images',
  imagesOutline: 'images-outline',
  scan: 'scan-outline',
  flashlight: 'flashlight',
  flashlightOutline: 'flashlight-outline',
  upload: 'cloud-upload-outline',
  sparkles: 'sparkles',
  sparklesOutline: 'sparkles-outline',
  bulb: 'bulb-outline',
  chat: 'chatbubble-ellipses-outline',

  hero: 'trophy',
  heroOutline: 'trophy-outline',
  medal: 'medal',
  star: 'star',
  people: 'people',
  peopleOutline: 'people-outline',
  person: 'person',
  personOutline: 'person-outline',
  personAdd: 'person-add',
  add: 'add',

  chevronRight: 'chevron-forward',
  chevronBack: 'chevron-back',
  chevronDown: 'chevron-down',
  arrowForward: 'arrow-forward',
  close: 'close',
  check: 'checkmark',
  checkCircle: 'checkmark-circle',
  checkDone: 'checkmark-done',
  alert: 'alert-circle',
  warning: 'warning',
  refresh: 'refresh',
  send: 'send',
  hand: 'hand-left',
  copy: 'copy-outline',
  share: 'share-social-outline',
  whatsapp: 'logo-whatsapp',
  mail: 'mail-outline',
  paypal: 'logo-paypal',
  lock: 'lock-closed',
  cash: 'cash-outline',
  card: 'card-outline',
  chart: 'stats-chart',
  time: 'time-outline',
  bell: 'notifications',
  bellOutline: 'notifications-outline',
  settings: 'settings',
  settingsOutline: 'settings-outline',
  phone: 'phone-portrait-outline',
  flame: 'flame',
  shield: 'shield-checkmark',
  qr: 'qr-code-outline',
  link: 'link-outline',
  globe: 'globe-outline',
  sync: 'sync',
  logOut: 'log-out-outline',
  information: 'information-circle-outline',
} as const satisfies Record<string, IconName>;

type Props = {
  name: IconName;
  size?: number;
  color?: string;
};

export function Icon({ name, size = 20, color = colors.text }: Props) {
  // A glyph is a private-use character. Without hiding it, a screen reader reads
  // the raw codepoint out of every label it sits beside — the meaning is already
  // in the text or the parent's label, so the glyph is decorative by contract.
  return (
    <Ionicons
      aria-hidden
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      name={name}
      size={size}
      color={color}
    />
  );
}
