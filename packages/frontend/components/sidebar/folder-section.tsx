import React from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { GlyphButton } from '@oxy.so/bloom/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@oxy.so/bloom/dropdown-menu';
import {
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  Pencil,
  Star,
  Trash2,
  Folder as FolderIcon,
} from 'lucide-react-native';
import { bloomIcon, MenuRowIcon } from '@/lib/bloom-icon';
import { useTranslation } from '@/hooks/useTranslation';
import type { Conversation } from '@clarity/shared-types';
type Folder = {
  id: string;
  name: string;
  icon?: string;
  color?: string;
  conversationIds: string[];
  isExpanded?: boolean;
  isFavorite?: boolean;
};
type Project = {
  id: string;
  name: string;
  icon?: string;
  color?: string;
  conversationIds: string[];
  isExpanded?: boolean;
};
import { ConversationItem } from './conversation-item';

const ICON_MAP: Record<string, any> = {
  Folder: FolderIcon,
  FolderIcon,
};

interface FolderSectionProps {
  folder: Folder;
  conversations: Conversation[];
  currentChatId?: string;
  favoriteIds: string[];
  pinnedIds: string[];
  projects: Project[];
  folders: Folder[];
  onToggle: (id: string) => void;
  onEdit: (folder: Folder, e: any) => void;
  onDelete: (id: string, e: any) => void;
  onToggleFavorite: (folder: Folder, e: any) => void;
  onSelectConversation: (id: string) => void;
  onToggleFavoriteConversation: (id: string, e: any) => void;
  onTogglePinConversation: (id: string, e: any) => void;
  onMoveToProject: (convId: string, projectId: string | null, e: any) => void;
  onMoveToFolder: (convId: string, folderId: string | null, e: any) => void;
  onDeleteConversation: (id: string, e: any) => void;
  onPrefetchConversation?: (id: string) => void;
  getConversationProject: (id: string) => Project | undefined;
  getConversationFolder: (id: string) => Folder | undefined;
}

export const FolderSection = React.memo<FolderSectionProps>(
  ({
    folder,
    conversations,
    currentChatId,
    favoriteIds,
    pinnedIds,
    projects,
    folders,
    onToggle,
    onEdit,
    onDelete,
    onToggleFavorite,
    onSelectConversation,
    onToggleFavoriteConversation,
    onTogglePinConversation,
    onMoveToProject,
    onMoveToFolder,
    onDeleteConversation,
    onPrefetchConversation,
    getConversationProject,
    getConversationFolder,
  }) => {
    const { t } = useTranslation();
    const Icon = ICON_MAP[folder.icon || 'Folder'] || FolderIcon;

    return (
      <View className="gap-0.5">
        {/* Folder Header */}
        <View className="flex-row items-center gap-1 rounded-lg group">
          <Pressable
            onPress={() => onToggle(folder.id)}
            className="flex-1 flex-row items-center gap-2 py-1.5 px-2 active:bg-muted/50 rounded-lg"
          >
            <Icon size={14} className="text-muted-foreground" style={{ color: folder.color }} />
            <Text className="flex-1 text-xs text-foreground font-medium" numberOfLines={1}>
              {folder.name}
            </Text>
            <Text className="text-xs text-muted-foreground mr-1">{conversations.length}</Text>
            {folder.isExpanded ? (
              <ChevronDown size={12} className="text-muted-foreground" />
            ) : (
              <ChevronRight size={12} className="text-muted-foreground" />
            )}
          </Pressable>
          <DropdownMenu>
            <DropdownMenuTrigger
              asChild
              label={t('actions.more')}
              style={{ marginRight: 4, alignSelf: 'center' }}
            >
              <GlyphButton
                size={28}
                glyphSize={12}
                icon={bloomIcon(MoreHorizontal)}
                accessibilityLabel={t('actions.more')}
              />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem
                leading={<MenuRowIcon icon={Star} />}
                onPress={() => onToggleFavorite(folder, {})}
              >
                {folder.isFavorite ? 'Unfavorite' : 'Favorite'}
              </DropdownMenuItem>
              <DropdownMenuItem
                leading={<MenuRowIcon icon={Pencil} />}
                onPress={() => onEdit(folder, {})}
              >
                Edit Folder
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                tone="danger"
                leading={<MenuRowIcon icon={Trash2} tone="danger" />}
                onPress={() => onDelete(folder.id, {})}
              >
                Delete Folder
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </View>

        {/* Folder Conversations */}
        {folder.isExpanded &&
          conversations
            .sort(
              (a, b) => (favoriteIds.includes(b.id) ? 1 : 0) - (favoriteIds.includes(a.id) ? 1 : 0),
            )
            .map((conv) => (
              <ConversationItem
                key={conv.id}
                conversation={conv}
                isActive={currentChatId === conv.id}
                isFavorite={favoriteIds.includes(conv.id)}
                isPinned={pinnedIds.includes(conv.id)}
                currentProject={getConversationProject(conv.id)}
                currentFolder={getConversationFolder(conv.id)}
                projects={projects}
                folders={folders}
                onSelect={onSelectConversation}
                onToggleFavorite={onToggleFavoriteConversation}
                onTogglePin={onTogglePinConversation}
                onMoveToProject={onMoveToProject}
                onMoveToFolder={onMoveToFolder}
                onDelete={onDeleteConversation}
                onPrefetch={onPrefetchConversation}
                compact
                indented
              />
            ))}
      </View>
    );
  },
);

FolderSection.displayName = 'FolderSection';
