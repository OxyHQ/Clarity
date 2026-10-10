import { Mic } from 'lucide-react-native';
import { GlyphButton } from '@oxy.so/bloom/button';
import { toast } from '@oxy.so/bloom/toast';
import { bloomIcon } from '@/lib/bloom-icon';
import { useTranslation } from '@/hooks/useTranslation';

export function PromptInputMicButton() {
  const { t } = useTranslation();
  const handlePress = () => {
    toast.info('Speech-to-text is not available yet.');
  };

  return (
    <GlyphButton
      size={32}
      glyphSize={16}
      icon={bloomIcon(Mic)}
      onPress={handlePress}
      accessibilityLabel={t('actions.voiceInput')}
    />
  );
}
