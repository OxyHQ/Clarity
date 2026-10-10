import { View, Pressable } from 'react-native';
import { Image } from 'expo-image';
import { Text } from '@/components/ui/text';
import { FileText, Image as ImageIcon, File, MoreHorizontal, Trash2 } from 'lucide-react-native';
import { GlyphButton } from '@oxy.so/bloom/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@oxy.so/bloom/dropdown-menu';
import { bloomIcon, MenuRowIcon } from '@/lib/bloom-icon';
import { useTranslation } from '@/hooks/useTranslation';
interface LibraryFile {
  name: string;
  type: string;
  size: number;
  category: string;
  thumbnail?: string;
  createdAt: Date;
}
import { formatFileSize } from '@/lib/utils';

interface FileCardProps {
  file: LibraryFile;
  onPress?: (file: LibraryFile) => void;
  onDelete?: (file: LibraryFile) => void;
}

export function FileCard({ file, onPress, onDelete }: FileCardProps) {
  const { t } = useTranslation();
  const getFileIcon = () => {
    if (file.category === 'images') {
      return <ImageIcon size={16} className="text-blue-500" />;
    } else if (file.category === 'documents') {
      return <FileText size={16} className="text-green-500" />;
    } else {
      return <File size={16} className="text-muted-foreground" />;
    }
  };

  const formatDate = (date: Date): string => {
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return `${days}d ago`;

    return date.toLocaleDateString();
  };

  const subtitle = [
    file.type.split('/').pop()?.toUpperCase(),
    file.size > 0 ? formatFileSize(file.size) : null,
    formatDate(file.createdAt),
  ]
    .filter(Boolean)
    .join(' \u00B7 ');

  return (
    <Pressable onPress={() => onPress?.(file)} className="active:opacity-70">
      <View className="flex-row items-center py-2.5 gap-3">
        {/* Thumbnail / Icon */}
        <View className="w-9 h-9 rounded-full bg-muted items-center justify-center overflow-hidden">
          {file.category === 'images' && file.thumbnail ? (
            <Image
              source={{ uri: file.thumbnail }}
              className="w-9 h-9"
              contentFit="cover"
              transition={200}
            />
          ) : (
            getFileIcon()
          )}
        </View>

        {/* Content */}
        <View className="flex-1">
          <Text className="text-[14px] font-semibold text-foreground" numberOfLines={1}>
            {file.name}
          </Text>
          <Text className="text-xs text-muted-foreground" numberOfLines={1}>
            {subtitle}
          </Text>
        </View>

        {/* Actions */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild label={t('actions.more')} style={{ alignSelf: 'center' }}>
            <GlyphButton
              size={32}
              glyphSize={14}
              icon={bloomIcon(MoreHorizontal)}
              accessibilityLabel={t('actions.more')}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem
              tone="danger"
              leading={<MenuRowIcon icon={Trash2} tone="danger" />}
              onPress={() => onDelete?.(file)}
            >
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </View>
    </Pressable>
  );
}
