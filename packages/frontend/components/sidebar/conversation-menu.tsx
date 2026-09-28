import React from "react";
import { View } from "react-native";
import { GlyphButton } from "@oxy.so/bloom/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@oxy.so/bloom/dropdown-menu";
import { Check, Folder as FolderIcon, MoreHorizontal, Pin, PinOff, Star, Trash2 } from "lucide-react-native";
import { bloomIcon, MenuRowIcon } from "@/lib/bloom-icon";
import { useTranslation } from "@/hooks/useTranslation";
import type { Conversation } from "@clarity/shared-types";
type Project = { id: string; name: string; icon?: string; color?: string; conversationIds: string[]; isExpanded?: boolean };
type Folder = { id: string; name: string; icon?: string; color?: string; conversationIds: string[]; isExpanded?: boolean; isFavorite?: boolean };

interface ConversationMenuProps {
  conversation: Conversation;
  currentProject?: Project;
  currentFolder?: Folder;
  isFavorite: boolean;
  isPinned: boolean;
  projects: Project[];
  folders: Folder[];
  onToggleFavorite: (id: string, e: any) => void;
  onTogglePin: (id: string, e: any) => void;
  onMoveToProject: (convId: string, projectId: string | null, e: any) => void;
  onMoveToFolder: (convId: string, folderId: string | null, e: any) => void;
  onDelete: (id: string, e: any) => void;
}

export const ConversationMenu = React.memo<ConversationMenuProps>(({
  conversation,
  currentProject,
  currentFolder,
  isFavorite,
  isPinned,
  projects,
  folders,
  onToggleFavorite,
  onTogglePin,
  onMoveToProject,
  onMoveToFolder,
  onDelete,
}) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = React.useState(false);

  return (
    <DropdownMenu onOpenChange={setIsOpen}>
      <View className="relative h-8 w-8 items-center justify-center mr-1">
        {(isPinned || isFavorite) && !isOpen && (
          <View pointerEvents="none" className="absolute inset-0 items-center justify-center group-hover:opacity-0">
            {isPinned ? (
              <Pin size={14} className={isFavorite ? "text-amber-500" : "text-muted-foreground"} />
            ) : (
              <Star size={14} className="text-amber-500" fill="#f59e0b" />
            )}
          </View>
        )}
        <DropdownMenuTrigger
          asChild
          label={t("actions.more")}
          className={isOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100"}
        >
          <GlyphButton
            size={32}
            glyphSize={14}
            icon={bloomIcon(MoreHorizontal)}
            accessibilityLabel={t("actions.more")}
          />
        </DropdownMenuTrigger>
      </View>
      <DropdownMenuContent>
        <DropdownMenuItem
          leading={<MenuRowIcon icon={Star} />}
          onPress={() => onToggleFavorite(conversation.id, {})}
        >
          {isFavorite ? "Unfavorite" : "Favorite"}
        </DropdownMenuItem>
        <DropdownMenuItem
          leading={<MenuRowIcon icon={isPinned ? PinOff : Pin} />}
          onPress={() => onTogglePin(conversation.id, {})}
        >
          {isPinned ? "Unpin" : "Pin"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />

        {/* Move to Project */}
        <DropdownMenuLabel>Move to Project</DropdownMenuLabel>
        <DropdownMenuItem
          leading={<MenuRowIcon icon={!currentProject ? Check : FolderIcon} />}
          onPress={() => onMoveToProject(conversation.id, null, {})}
        >
          No Project
        </DropdownMenuItem>
        {projects.map((project) => (
          <DropdownMenuItem
            key={`project-${project.id}`}
            leading={<MenuRowIcon icon={currentProject?.id === project.id ? Check : FolderIcon} />}
            onPress={() => onMoveToProject(conversation.id, project.id, {})}
          >
            {project.name}
          </DropdownMenuItem>
        ))}

        <DropdownMenuSeparator />

        {/* Move to Folder */}
        <DropdownMenuLabel>Move to Folder</DropdownMenuLabel>
        <DropdownMenuItem
          leading={<MenuRowIcon icon={!currentFolder ? Check : FolderIcon} />}
          onPress={() => onMoveToFolder(conversation.id, null, {})}
        >
          No Folder
        </DropdownMenuItem>
        {folders.map((folder) => (
          <DropdownMenuItem
            key={`folder-${folder.id}`}
            leading={<MenuRowIcon icon={currentFolder?.id === folder.id ? Check : FolderIcon} />}
            onPress={() => onMoveToFolder(conversation.id, folder.id, {})}
          >
            {folder.name}
          </DropdownMenuItem>
        ))}

        <DropdownMenuSeparator />
        <DropdownMenuItem
          tone="danger"
          leading={<MenuRowIcon icon={Trash2} tone="danger" />}
          onPress={() => onDelete(conversation.id, {})}
        >
          Delete Conversation
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

ConversationMenu.displayName = "ConversationMenu";
