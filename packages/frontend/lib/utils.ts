import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** NativeWind class names, merged so a later class overrides an earlier one. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
