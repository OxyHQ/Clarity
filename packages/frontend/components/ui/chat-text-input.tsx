import * as React from "react";
import {
  TextInput,
  Platform,
  View,
  type NativeSyntheticEvent,
  type TextInputKeyPressEventData,
  type NativeSyntheticEvent as RNSyntheticEvent,
  type TextInputContentSizeChangeEventData,
} from "react-native";
import { cn } from "@/lib/utils";

type ChatTextInputProps = React.ComponentPropsWithoutRef<typeof TextInput> & {
  noFocus?: boolean;
  onEnterPress?: () => void;
  onCompletionKey?: (key: string) => boolean;
  maxHeight?: number;
  minHeight?: number;
  onHeightChange?: (height: number) => void;
  disableEnterToSubmit?: boolean;
  disableAutoHeight?: boolean;
  onImagePaste?: (files: File[]) => void;
  fillContainer?: boolean;
};

const ChatTextInput = React.forwardRef<TextInput, ChatTextInputProps>(
  ({
    className,
    noFocus = false,
    onEnterPress,
    onCompletionKey,
    onKeyPress,
    maxHeight = 200,
    minHeight = 44,
    onContentSizeChange,
    onHeightChange,
    style,
    disableEnterToSubmit = false,
    disableAutoHeight = false,
    onImagePaste,
    fillContainer = false,
    ...props
  }, ref) => {
    const inputRef = React.useRef<TextInput>(null);
    // Stable DOM id for the wrapper so the web paste handler can resolve the
    // element via document.getElementById (react-native-web renders the RN `id`
    // prop as the DOM id). Strip non-alphanumerics from useId() to match the id
    // react-native-web actually writes.
    const rawWrapperId = React.useId();
    const wrapperId = React.useMemo(
      () => `chat-input-wrapper-${rawWrapperId.replace(/[^a-zA-Z0-9]/g, '')}`,
      [rawWrapperId],
    );

    // Combine refs
    React.useImperativeHandle(ref, () => inputRef.current as TextInput);

    // Attach paste event listener (web only) using document-level listener
    React.useEffect(() => {
      if (Platform.OS !== 'web' || !onImagePaste) return;

      const handlePaste = (e: Event) => {
        const clipboardEvent = e as ClipboardEvent;

        // Only handle paste if our input is currently focused
        const wrapper = document.getElementById(wrapperId);
        const isContained = !!wrapper && wrapper.contains(document.activeElement);

        if (!isContained) return;

        const items = clipboardEvent.clipboardData?.items;
        if (!items) return;

        const imageFiles: File[] = [];
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (item.type.indexOf('image') !== -1) {
            const file = item.getAsFile();
            if (file) {
              imageFiles.push(file);
            }
          }
        }

        if (imageFiles.length > 0) {
          clipboardEvent.preventDefault();
          onImagePaste(imageFiles);
        }
      };

      document.addEventListener('paste', handlePaste);

      return () => {
        document.removeEventListener('paste', handlePaste);
      };
    }, [onImagePaste, wrapperId]);

    const handleKeyPress = (
      e: NativeSyntheticEvent<TextInputKeyPressEventData>
    ) => {
      // Call the original onKeyPress if provided
      onKeyPress?.(e);

      const key = e.nativeEvent.key;

      // Arrow keys and Enter — autocomplete navigation
      if (onCompletionKey && (key === "ArrowUp" || key === "ArrowDown" || key === "Enter" || key === "Escape")) {
        if (onCompletionKey(key)) {
          e.preventDefault();
          return;
        }
      }

      // Handle Enter key press (without Shift on web)
      if (key === "Enter" && !disableEnterToSubmit) {
        // `shiftKey` is present on web key events (react-native-web) but absent
        // from RN's TextInputKeyPressEventData; widen the type to read it safely.
        const nativeEvent: { key: string; shiftKey?: boolean } = e.nativeEvent;
        if (Platform.OS !== 'web' || !nativeEvent.shiftKey) {
          e.preventDefault();
          onEnterPress?.();
        }
      }
    };

    const handleContentSizeChange = (
      e: RNSyntheticEvent<TextInputContentSizeChangeEventData>
    ) => {
      onContentSizeChange?.(e);
    };

    return (
      <View
        id={wrapperId}
        style={{ width: '100%', ...(fillContainer && { flex: 1 }) }}
        onLayout={(e) => onHeightChange?.(e.nativeEvent.layout.height)}
      >
        <TextInput
          ref={inputRef}
          accessibilityLabel="Message input"
          className={cn(
            "native:text-md native:leading-[1.25] rounded-xl border border-input bg-background px-3.5 text-base text-foreground file:border-0 file:bg-transparent file:font-medium placeholder:text-muted-foreground web:flex web:w-full web:py-2 lg:text-sm",
            "web:ring-offset-background web:focus-visible:outline-none web:focus-visible:ring-2 web:focus-visible:ring-ring web:focus-visible:ring-offset-2",
            !fillContainer && !props.multiline && "h-9",
            fillContainer && "h-full",
            noFocus && "web:focus-visible:ring-0 web:focus-visible:ring-offset-0",
            props.editable === false && "opacity-50 web:cursor-not-allowed",
            className
          )}
          placeholderClassName={cn("text-muted-foreground", props.placeholderClassName)}
          onKeyPress={handleKeyPress}
          onContentSizeChange={handleContentSizeChange}
          scrollEnabled={fillContainer || props.multiline}
          style={[
            style,
            !fillContainer && props.multiline && !disableAutoHeight && {
              minHeight,
              maxHeight,
              overflow: 'auto',
              ...(Platform.OS === 'web' ? { fieldSizing: 'content' } : {}),
            },
            fillContainer && { flex: 1, height: '100%' },
          ]}
          {...props}
        />
      </View>
    );
  }
);

ChatTextInput.displayName = "ChatTextInput";

export { ChatTextInput };
