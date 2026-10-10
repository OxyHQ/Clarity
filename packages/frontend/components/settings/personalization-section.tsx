import { View, TextInput as RNTextInput } from 'react-native';
import { Text } from '@/components/ui/text';
import { Button } from '@oxy.so/bloom/button';
import { useState, useEffect } from 'react';
import { useOxy } from '@oxy.so/services';
import { useApiClient } from '@/lib/api/use-api-client';
import { Globe, MapPin, Briefcase, User as UserIcon, Languages } from 'lucide-react-native';
import { PersonalityStylePicker } from './personality-style-picker';
import { useUserData } from '@/hooks/useUserData';
import { useUserDataStore } from '@/lib/stores/user-data-store';
import type { UserMemory } from '@/lib/stores/user-data-store';
import {
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectTrigger,
  SelectValue,
} from '@oxy.so/bloom/select';
import { useTranslation } from '@/hooks/useTranslation';
import { toast } from '@oxy.so/bloom/toast';

const LANGUAGES = [
  { value: 'en-US', label: 'English' },
  { value: 'es-ES', label: 'Español' },
  { value: 'fr-FR', label: 'Français' },
  { value: 'de-DE', label: 'Deutsch' },
  { value: 'it-IT', label: 'Italiano' },
  { value: 'pt-BR', label: 'Português' },
  { value: 'zh-CN', label: '中文' },
  { value: 'ja-JP', label: '日本語' },
  { value: 'ko-KR', label: '한국어' },
  { value: 'ru-RU', label: 'Русский' },
  { value: 'ar-SA', label: 'العربية' },
  { value: 'hi-IN', label: 'हिन्दी' },
];

export function PersonalizationSection() {
  const { isAuthenticated } = useOxy();
  const client = useApiClient();
  const { memory } = useUserData();
  const setMemory = useUserDataStore((state) => state.setMemory);
  const [saving, setSaving] = useState(false);
  const { t } = useTranslation();

  const [language, setLanguage] = useState('');
  const [tone, setTone] = useState('');
  const [occupation, setOccupation] = useState('');
  const [location, setLocation] = useState('');
  const [bio, setBio] = useState('');
  const [interests, setInterests] = useState('');

  useEffect(() => {
    if (memory) {
      setLanguage(memory.preferences?.language || '');
      setTone(memory.preferences?.tone || '');
      setOccupation(memory.context?.occupation || '');
      setLocation(memory.context?.location || '');
      setBio(memory.context?.bio || '');
      setInterests(memory.preferences?.interests?.join(', ') || '');
    }
  }, [memory]);

  const handleCancel = () => {
    if (memory) {
      setLanguage(memory.preferences?.language || '');
      setTone(memory.preferences?.tone || '');
      setOccupation(memory.context?.occupation || '');
      setLocation(memory.context?.location || '');
      setBio(memory.context?.bio || '');
      setInterests(memory.preferences?.interests?.join(', ') || '');
    }
  };

  const handleSave = async () => {
    if (!isAuthenticated) return;

    setSaving(true);
    try {
      await client.put('/memory/preferences', {
        language,
        tone,
        interests: interests
          .split(',')
          .map((i) => i.trim())
          .filter(Boolean),
      });

      const updatedMemory = await client.put<UserMemory>('/memory/context', {
        occupation,
        location,
        bio,
      });

      setMemory(updatedMemory);
      toast.success(t('settings.saveSuccess'));
    } catch {
      toast.error(t('settings.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    'border border-border rounded-lg px-3 py-2 bg-background text-foreground text-sm';

  return (
    <View className="gap-5">
      {/* Clarity's Language */}
      <View className="gap-1.5">
        <View className="flex-row items-center gap-2">
          <Languages size={18} className="text-primary" />
          <Text className="text-sm font-semibold">{t('settings.clarityLanguage.title')}</Text>
        </View>
        <Text className="text-xs text-muted-foreground">
          {t('settings.clarityLanguage.description')}
        </Text>
        <Select value={language || undefined} onValueChange={setLanguage}>
          <SelectTrigger label={t('settings.clarityLanguage.title')}>
            <SelectValue placeholder={t('settings.clarityLanguage.selectPlaceholder')} />
            <SelectIcon />
          </SelectTrigger>
          <SelectContent
            label={t('settings.clarityLanguage.title')}
            items={LANGUAGES}
            renderItem={(lang) => (
              <SelectItem value={lang.value} label={lang.label}>
                <SelectItemIndicator />
                <SelectItemText>{lang.label}</SelectItemText>
              </SelectItem>
            )}
          />
        </Select>
      </View>

      {/* Personality Style */}
      <PersonalityStylePicker selectedStyle={tone} onSelectStyle={setTone} />

      {/* Occupation */}
      <View className="gap-1.5">
        <View className="flex-row items-center gap-2">
          <Briefcase size={18} className="text-primary" />
          <Text className="text-sm font-semibold">{t('settings.occupation.title')}</Text>
        </View>
        <Text className="text-xs text-muted-foreground">
          {t('settings.occupation.description')}
        </Text>
        <RNTextInput
          className={inputClass}
          placeholder={t('settings.occupation.placeholder')}
          placeholderTextColor="#9ca3af"
          value={occupation}
          onChangeText={setOccupation}
        />
      </View>

      {/* Location */}
      <View className="gap-1.5">
        <View className="flex-row items-center gap-2">
          <MapPin size={18} className="text-primary" />
          <Text className="text-sm font-semibold">{t('settings.location.title')}</Text>
        </View>
        <Text className="text-xs text-muted-foreground">{t('settings.location.description')}</Text>
        <RNTextInput
          className={inputClass}
          placeholder={t('settings.location.placeholder')}
          placeholderTextColor="#9ca3af"
          value={location}
          onChangeText={setLocation}
        />
      </View>

      {/* Bio */}
      <View className="gap-1.5">
        <View className="flex-row items-center gap-2">
          <UserIcon size={18} className="text-primary" />
          <Text className="text-sm font-semibold">{t('settings.aboutYou.title')}</Text>
        </View>
        <Text className="text-xs text-muted-foreground">{t('settings.aboutYou.description')}</Text>
        <RNTextInput
          className={inputClass}
          placeholder={t('settings.aboutYou.placeholder')}
          placeholderTextColor="#9ca3af"
          value={bio}
          onChangeText={setBio}
          multiline
          numberOfLines={3}
        />
      </View>

      {/* Interests */}
      <View className="gap-1.5">
        <View className="flex-row items-center gap-2">
          <Globe size={18} className="text-primary" />
          <Text className="text-sm font-semibold">{t('settings.interests.title')}</Text>
        </View>
        <Text className="text-xs text-muted-foreground">{t('settings.interests.description')}</Text>
        <RNTextInput
          className={inputClass}
          placeholder={t('settings.interests.placeholder')}
          placeholderTextColor="#9ca3af"
          value={interests}
          onChangeText={setInterests}
          multiline
        />
      </View>

      {/* Save / Cancel */}
      <View className="flex-row gap-2 mt-2">
        <Button
          appearance="outline"
          tone="neutral"
          className="flex-1"
          onPress={handleCancel}
          disabled={saving}
        >
          {t('common.cancel')}
        </Button>
        <Button className="flex-1" onPress={handleSave} disabled={saving} loading={saving}>
          {t('settings.saveButton')}
        </Button>
      </View>
    </View>
  );
}
