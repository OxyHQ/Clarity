import React from 'react';
import { File, Image as ImageIcon, Plus } from 'lucide-react-native';
import { GlyphButton } from '@oxy.so/bloom/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@oxy.so/bloom/dropdown-menu';
import { bloomIcon, MenuRowIcon } from '@/lib/bloom-icon';
import { useTranslation } from '@/hooks/useTranslation';
import { useImagePicker } from '@/hooks/useImagePicker';
import { useDocumentPicker } from '@/hooks/useDocumentPicker';
import { usePromptInput } from './context';

export type PromptInputAddMenuProps = {
  className?: string;
  iconSize?: number;
};

export function PromptInputAddMenu({ className, iconSize = 16 }: PromptInputAddMenuProps) {
  const { t } = useTranslation();
  const { addAttachment } = usePromptInput();
  const { pickImage } = useImagePicker();
  const { pickDocument } = useDocumentPicker();

  const handleAddPhotos = async () => {
    try {
      const assets = await pickImage();
      if (assets && assets.length > 0) {
        assets.forEach((asset) => {
          addAttachment({
            id: `img-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            uri: asset.uri,
            type: 'image',
            name: asset.name,
            size: asset.size,
            mimeType: asset.mimeType,
          });
        });
      }
    } catch (err) {
      console.error('Error picking images:', err);
    }
  };

  const handleAddDocument = async () => {
    try {
      const docs = await pickDocument();
      if (docs && docs.length > 0) {
        docs.forEach((doc) => {
          addAttachment({
            id: `doc-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            uri: doc.uri,
            type: 'document',
            name: doc.name,
            size: doc.size,
            mimeType: doc.mimeType,
          });
        });
      }
    } catch (err) {
      console.error('Error picking documents:', err);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild label={t('actions.addAttachment')} className={className}>
        <GlyphButton
          size={32}
          glyphSize={iconSize}
          icon={bloomIcon(Plus)}
          accessibilityLabel={t('actions.addAttachment')}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start">
        <DropdownMenuItem leading={<MenuRowIcon icon={ImageIcon} />} onPress={handleAddPhotos}>
          Add photos
        </DropdownMenuItem>
        <DropdownMenuItem leading={<MenuRowIcon icon={File} />} onPress={handleAddDocument}>
          Add document
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
