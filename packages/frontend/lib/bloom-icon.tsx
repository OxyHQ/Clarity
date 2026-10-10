import type { BloomIconComponent } from '@oxy.so/bloom/icons';
import { useTheme } from '@oxy.so/bloom/theme';
import type { LucideIcon } from 'lucide-react-native';

const adapted = new WeakMap<LucideIcon, BloomIconComponent>();

/**
 * A Lucide icon as a Bloom icon slot (`leadingIcon`, `icon`, `TabsTrigger.leadingIcon`, …).
 *
 * Bloom draws a slot icon as `<Icon width height fill>` with the control's own
 * foreground colour; Lucide takes `size` and `color`. This maps one onto the other,
 * so a Bloom control paints the app's Lucide icons in its own state colours
 * (hover, pressed, disabled, selected) instead of a colour the caller guessed.
 *
 * The adapted component is cached per icon, so its identity is stable across
 * renders and passing `bloomIcon(Share2)` inline never remounts the icon.
 */
export function bloomIcon(Icon: LucideIcon): BloomIconComponent {
  const cached = adapted.get(Icon);
  if (cached) return cached;
  const BloomLucideIcon: BloomIconComponent = ({ width, height, fill }) => (
    <Icon size={width ?? height} color={fill} />
  );
  BloomLucideIcon.displayName = `bloomIcon(${Icon.displayName ?? 'Lucide'})`;
  adapted.set(Icon, BloomLucideIcon);
  return BloomLucideIcon;
}

/**
 * A Lucide icon for a Bloom menu row's `leading` slot.
 *
 * Menu rows take a NODE there, not a component, and do not paint it: Bloom's
 * menu recipe draws row glyphs at 16px in the secondary text colour, and a
 * destructive row's glyph in the same colour as its label.
 */
export function MenuRowIcon({ icon: Icon, tone }: { icon: LucideIcon; tone?: 'danger' }) {
  const { colors } = useTheme();
  return (
    <Icon
      size={16}
      color={tone === 'danger' ? colors.errorSubtleForeground : colors.textSecondary}
    />
  );
}
