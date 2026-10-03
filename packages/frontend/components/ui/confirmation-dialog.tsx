import { Button, type ButtonProps } from "@oxy.so/bloom/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useTranslation } from "@/hooks/useTranslation";

interface ConfirmationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmText?: string;
  cancelText?: string;
  confirmTone?: ButtonProps['tone'];
  onConfirm: () => void | Promise<void>;
  loading?: boolean;
}

export function ConfirmationDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmText,
  cancelText,
  confirmTone = "accent",
  onConfirm,
  loading = false,
}: ConfirmationDialogProps) {
  const { t } = useTranslation();

  const handleConfirm = async () => {
    await onConfirm();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeButton={true} className="max-w-sm">
        <DialogHeader className="gap-1">
          <DialogTitle className="text-lg">{title}</DialogTitle>
          <DialogDescription className="text-sm">{description}</DialogDescription>
        </DialogHeader>

        <DialogFooter className="gap-2 mt-2">
          <Button
            appearance="outline"
            className="flex-1"
            onPress={() => onOpenChange(false)}
            disabled={loading}
          >
            {cancelText || t('common.cancel')}
          </Button>
          <Button
            appearance="solid" tone={confirmTone}
            className="flex-1"
            onPress={handleConfirm}
            disabled={loading}
            loading={loading}
          >
            {confirmText || t('common.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
