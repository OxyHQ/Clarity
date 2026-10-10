import React from 'react';
import { View, ScrollView, ActivityIndicator } from 'react-native';
import { CloseButton } from '@oxy.so/bloom/button';
import { Image } from 'expo-image';
import {
  FileText,
  FileSpreadsheet,
  FileCode,
  FileArchive,
  FileAudio,
  File,
} from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { formatFileSize } from '@/lib/utils';
import { usePromptInput, type Attachment } from './context';

const REMOVE_BUTTON_POSITION = { position: 'absolute', top: 6, right: 6 } as const;

function getDocumentIcon(mimeType: string, name: string) {
  const ext = name.split('.').pop()?.toLowerCase() || '';

  if (mimeType === 'application/pdf' || ext === 'pdf')
    return { Icon: FileText, color: '#EF4444', bgColor: '#EF444418' };
  if (mimeType.includes('word') || ['doc', 'docx'].includes(ext))
    return { Icon: FileText, color: '#3B82F6', bgColor: '#3B82F618' };
  if (
    mimeType.includes('spreadsheet') ||
    mimeType.includes('excel') ||
    ['xls', 'xlsx', 'csv'].includes(ext)
  )
    return {
      Icon: FileSpreadsheet,
      color: '#22C55E',
      bgColor: '#22C55E18',
    };
  if (
    [
      'js',
      'ts',
      'tsx',
      'jsx',
      'py',
      'rb',
      'go',
      'rs',
      'java',
      'c',
      'cpp',
      'h',
      'json',
      'xml',
      'yaml',
      'yml',
      'html',
      'css',
      'scss',
      'sh',
      'sql',
    ].includes(ext)
  )
    return { Icon: FileCode, color: '#8B5CF6', bgColor: '#8B5CF618' };
  if (
    mimeType.includes('zip') ||
    mimeType.includes('archive') ||
    ['zip', 'rar', 'tar', 'gz', '7z'].includes(ext)
  )
    return { Icon: FileArchive, color: '#EAB308', bgColor: '#EAB30818' };
  if (mimeType.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'flac', 'aac'].includes(ext))
    return { Icon: FileAudio, color: '#EC4899', bgColor: '#EC489918' };
  if (mimeType === 'text/plain' || ['txt', 'md', 'rtf'].includes(ext))
    return { Icon: FileText, color: '#6B7280', bgColor: '#6B728018' };
  return { Icon: File, color: '#9CA3AF', bgColor: '#9CA3AF18' };
}

function truncateFilename(name: string, maxLength = 20): string {
  if (name.length <= maxLength) return name;
  const lastDot = name.lastIndexOf('.');
  if (lastDot < 0) return `${name.slice(0, maxLength - 3)}...`;
  const ext = name.slice(lastDot);
  const base = name.slice(0, lastDot);
  const available = maxLength - ext.length - 3;
  if (available <= 0) return `${name.slice(0, maxLength - 3)}...`;
  return `${base.slice(0, available)}...${ext}`;
}

function AttachmentItem({
  attachment,
  onRemove,
}: {
  attachment: Attachment;
  onRemove: () => void;
}) {
  if (attachment.type === 'image') {
    return (
      <View
        className="relative rounded-2xl overflow-hidden bg-muted border border-border"
        style={{ width: 120, height: 120 }}
      >
        {!attachment.isLoading && attachment.uri ? (
          <Image source={{ uri: attachment.uri }} className="w-full h-full" contentFit="cover" />
        ) : (
          <View className="absolute inset-0 items-center justify-center bg-muted">
            <ActivityIndicator size="small" />
          </View>
        )}
        {attachment.name && !attachment.isLoading && (
          <View
            className="absolute bottom-0 left-0 right-0 px-2 py-1"
            style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
          >
            <Text className="text-[11px] text-white" numberOfLines={1}>
              {truncateFilename(attachment.name)}
            </Text>
          </View>
        )}
        <CloseButton
          onPress={onRemove}
          size="sm"
          accessibilityLabel={`Remove ${attachment.name || 'image'}`}
          style={REMOVE_BUTTON_POSITION}
        />
      </View>
    );
  }

  const { Icon, color, bgColor } = getDocumentIcon(attachment.mimeType, attachment.name);

  return (
    <View
      className="relative rounded-2xl border border-border overflow-hidden bg-muted/30"
      style={{ width: 180, height: 80 }}
    >
      <View className="flex-1 flex-row items-center px-3 gap-3">
        <View
          className="w-10 h-10 rounded-xl items-center justify-center"
          style={{ backgroundColor: bgColor }}
        >
          <Icon size={20} color={color} />
        </View>
        <View className="flex-1 pr-4">
          <Text className="text-xs font-medium text-foreground" numberOfLines={1}>
            {truncateFilename(attachment.name)}
          </Text>
          {attachment.size > 0 && (
            <Text className="text-[11px] text-muted-foreground mt-0.5">
              {formatFileSize(attachment.size)}
            </Text>
          )}
        </View>
      </View>
      <CloseButton
        onPress={onRemove}
        size="xs"
        accessibilityLabel={`Remove ${attachment.name || 'document'}`}
        style={REMOVE_BUTTON_POSITION}
      />
    </View>
  );
}

export function PromptInputAttachments() {
  const { attachments, removeAttachment } = usePromptInput();

  if (attachments.length === 0) return null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      className="mb-2 pt-2 flex-none"
      contentContainerClassName="gap-2.5 px-3"
    >
      {attachments.map((attachment) => (
        <View key={attachment.id} className="relative">
          <AttachmentItem
            attachment={attachment}
            onRemove={() => removeAttachment(attachment.id)}
          />
        </View>
      ))}
    </ScrollView>
  );
}
