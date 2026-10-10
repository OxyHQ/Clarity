import React from 'react';
import { ArrowUp, Square } from 'lucide-react-native';
import { Button } from '@oxy.so/bloom/button';
import { bloomIcon } from '@/lib/bloom-icon';
import { useTranslation } from '@/hooks/useTranslation';
import { usePromptInput } from './context';

export type PromptInputSubmitButtonProps = {
  isLoading?: boolean;
  onStop?: () => void;
  emptyAction?: React.ReactNode;
  className?: string;
};

export function PromptInputSubmitButton({
  isLoading,
  onStop,
  emptyAction,
  className,
}: PromptInputSubmitButtonProps) {
  const { t } = useTranslation();
  const { onSubmit, value, attachments } = usePromptInput();
  const hasContent = value.trim() || attachments.length > 0;

  if (isLoading && onStop) {
    return (
      <Button
        iconOnly
        size="sm"
        icon={bloomIcon(Square)}
        onPress={onStop}
        accessibilityLabel={t('actions.stop')}
        className={className}
      />
    );
  }

  if (!hasContent && emptyAction) {
    return <>{emptyAction}</>;
  }

  return (
    <Button
      iconOnly
      size="sm"
      icon={bloomIcon(ArrowUp)}
      onPress={onSubmit}
      disabled={!hasContent}
      accessibilityLabel={t('chat.sendButton')}
      className={className}
    />
  );
}
