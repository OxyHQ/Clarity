// Ambient type declarations for third-party modules that ship no types.
// Provides proper typings so consumers don't need @ts-expect-error / `as any`.

declare module 'react-native-syntax-highlighter' {
  import type { ComponentType, ReactNode } from 'react';

  interface SyntaxHighlighterProps {
    language?: string;
    style?: Record<string, unknown>;
    fontSize?: number;
    highlighter?: 'hljs' | 'prism';
    customStyle?: Record<string, unknown>;
    children?: ReactNode;
  }

  const SyntaxHighlighter: ComponentType<SyntaxHighlighterProps>;
  export default SyntaxHighlighter;
}

declare module 'react-syntax-highlighter/styles/hljs' {
  const styles: Record<string, Record<string, unknown>>;
  export const atomOneLight: Record<string, unknown>;
  export default styles;
}
