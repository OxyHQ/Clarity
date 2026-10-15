import { useExperienceClient } from '@/lib/api/use-experience-client';
import { useEffect, useState } from 'react';
import { ClarityError } from '@clarity.surf/sdk';
import { ScrollView, Text, View } from 'react-native';
import { useMutation } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services/ui/client';
import { Button } from '@oxy.so/bloom/button';
import { Dialog, useDialogControl } from '@oxy.so/bloom/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectItemText,
  SelectTrigger,
  SelectValue,
} from '@oxy.so/bloom/select';
import { Switch } from '@oxy.so/bloom/switch';
import { TextField, TextFieldInput, TextFieldLabel } from '@oxy.so/bloom/text-field';
import { useTranslation } from '@/hooks/useTranslation';
import {
  EXPERIENCE_EMPLOYMENT_TYPES,
  validateExperienceInput,
  type Experience,
  type ExperienceInput,
} from '@clarity.surf/sdk/experience';
import type { ExperienceEmployer } from './ExperienceEmployerField';
import { ExperienceEmployerField } from './ExperienceEmployerField';

export function ExperienceEditor({
  entry,
  ownerId,
  employer,
  onClose,
  onSaved,
}: {
  entry?: Experience;
  ownerId: string;
  employer?: ExperienceEmployer;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const control = useDialogControl();
  useEffect(() => {
    control.open();
  }, [control]);
  const experience = useExperienceClient();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { user, canUsePrivateApi } = useAuth();
  const canEdit = user?.id === ownerId && canUsePrivateApi;
  const [draft, setDraft] = useState<ExperienceInput>(() => ({
    title: entry?.title ?? '',
    employerOxyAccountId: entry?.employerOxyAccountId ?? '',
    employmentType: entry?.employmentType ?? null,
    location: entry?.location ?? null,
    startDate: entry?.startDate ?? '',
    endDate: entry?.endDate ?? null,
    description: entry?.description ?? null,
  }));
  const [errors, setErrors] = useState<string[]>([]);
  const save = useMutation({
    mutationFn: (input: ExperienceInput) => {
      if (!canEdit) throw new Error('Experience owner session is not ready');
      return entry ? experience.update(entry.id, input) : experience.create(input);
    },
    onSuccess: () => control.close(onSaved),
  });
  const remove = useMutation({
    mutationFn: () => {
      if (!canEdit || !entry) throw new Error('Experience owner session is not ready');
      return experience.delete(entry.id);
    },
    onSuccess: () => control.close(onSaved),
  });
  const busy = save.isPending || remove.isPending;
  function field<Key extends keyof ExperienceInput>(key: Key, value: ExperienceInput[Key]) {
    setDraft((previous) => ({ ...previous, [key]: value }));
    setErrors((previous) => previous.filter((field) => field !== key));
    save.reset();
    remove.reset();
  }
  function submit() {
    if (busy || !canEdit) return;
    const result = validateExperienceInput(draft);
    if (!result.success) {
      setErrors(result.issues.map((issue) => String(issue.path[0])));
      return;
    }
    save.mutate(result.data);
  }
  function textField(
    key: 'title' | 'location' | 'startDate' | 'endDate' | 'description',
    maxLength: number,
  ) {
    const invalid = errors.includes(key);
    return (
      <View className="gap-1">
        <TextFieldLabel>{t(`profile.experience.fields.${key}`)}</TextFieldLabel>
        <TextField invalid={invalid} disabled={busy}>
          <TextFieldInput
            label={t(`profile.experience.fields.${key}`)}
            value={draft[key] ?? ''}
            onChangeText={(value) =>
              field(
                key,
                (key === 'location' || key === 'description') && !value.trim() ? null : value,
              )
            }
            maxLength={maxLength}
            multiline={key === 'description'}
            autoCapitalize={key.endsWith('Date') ? 'none' : 'sentences'}
            placeholder={key.endsWith('Date') ? 'YYYY-MM' : undefined}
          />
        </TextField>
        {invalid ? (
          <Text accessibilityRole="alert" className="text-error-primary text-sm">
            {t(`profile.experience.validation.${key}`)}
          </Text>
        ) : null}
      </View>
    );
  }
  const employmentOptions = [
    { value: '', label: t('profile.experience.unspecified') },
    ...EXPERIENCE_EMPLOYMENT_TYPES.map((value) => ({
      value,
      label: t(`profile.experience.employment.${value}`),
    })),
  ];
  const title = t(entry ? 'profile.experience.edit' : 'profile.experience.add');
  return (
    <Dialog
      control={control}
      dismissOnBackdrop={!busy}
      title={confirmDelete ? t('profile.experience.deleteTitle') : title}
      label={confirmDelete ? t('profile.experience.deleteTitle') : title}
      actions={
        confirmDelete
          ? [
              {
                label: t('common.cancel'),
                color: 'cancel',
                disabled: busy,
                shouldCloseOnPress: false,
                onPress: () => setConfirmDelete(false),
              },
              {
                label: t('common.delete'),
                color: 'destructive',
                disabled: busy || !canEdit,
                shouldCloseOnPress: false,
                onPress: () => remove.mutate(),
              },
            ]
          : undefined
      }
      onClose={onClose}
    >
      {confirmDelete ? (
        <View className="gap-3">
          <Text className="text-foreground">{t('profile.experience.deleteDescription')}</Text>
          {remove.isError ? (
            <Text accessibilityRole="alert" className="text-error-primary">
              {t('profile.experience.deleteError')}
            </Text>
          ) : null}
        </View>
      ) : (
        <>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            style={{ maxHeight: 560 }}
            contentContainerStyle={{ paddingBottom: 8 }}
          >
            <View className="gap-4">
              <Text className="text-muted-foreground text-sm">
                {t('profile.experience.publicHint')}
              </Text>
              {textField('title', 200)}
              <ExperienceEmployerField
                initialEmployer={employer}
                value={draft.employerOxyAccountId}
                disabled={busy || !canEdit}
                invalid={errors.includes('employerOxyAccountId')}
                onChange={(organization) =>
                  field('employerOxyAccountId', organization?.accountId ?? '')
                }
              />
              <View className="gap-1">
                <TextFieldLabel>{t('profile.experience.fields.employmentType')}</TextFieldLabel>
                <Select
                  value={draft.employmentType ?? ''}
                  disabled={busy}
                  onValueChange={(value) =>
                    field(
                      'employmentType',
                      value
                        ? (EXPERIENCE_EMPLOYMENT_TYPES.find((type) => type === value) ?? null)
                        : null,
                    )
                  }
                >
                  <SelectTrigger label={t('profile.experience.fields.employmentType')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent
                    items={employmentOptions}
                    renderItem={(option) => (
                      <SelectItem value={option.value} label={option.label}>
                        <SelectItemText>{option.label}</SelectItemText>
                      </SelectItem>
                    )}
                  />
                </Select>
              </View>
              {textField('location', 300)}
              {textField('startDate', 7)}
              <View className="flex-row items-center justify-between gap-3">
                <Text className="text-foreground text-base flex-1">
                  {t('profile.experience.current')}
                </Text>
                <Switch
                  accessibilityLabel={t('profile.experience.current')}
                  checked={draft.endDate === null}
                  disabled={busy}
                  onCheckedChange={(current) => field('endDate', current ? null : '')}
                />
              </View>
              {draft.endDate !== null ? textField('endDate', 7) : null}
              <Text className="text-muted-foreground text-sm">
                {t('profile.experience.dateHint')}
              </Text>
              {textField('description', 5000)}
              {save.isError || remove.isError ? (
                <Text accessibilityRole="alert" className="text-error-primary text-sm">
                  {t(
                    remove.isError
                      ? 'profile.experience.deleteError'
                      : save.error instanceof ClarityError &&
                          save.error.code === 'experience_limit_reached'
                        ? 'profile.experience.limitReached'
                        : save.error instanceof ClarityError &&
                            save.error.code === 'invalid_employer'
                          ? 'profile.experience.validation.employerOxyAccountId'
                          : 'profile.experience.saveError',
                  )}
                </Text>
              ) : null}
            </View>
          </ScrollView>
          <View className="flex-row flex-wrap items-center justify-end gap-2 pt-4">
            {entry ? (
              <Button
                appearance="plain"
                tone="danger"
                onPress={() => setConfirmDelete(true)}
                disabled={busy || !canEdit}
                loading={remove.isPending}
              >
                {t('common.delete', { defaultValue: 'Delete' })}
              </Button>
            ) : null}
            <Button
              appearance="plain"
              tone="neutral"
              onPress={() => control.close()}
              disabled={busy}
            >
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button onPress={submit} disabled={busy || !canEdit} loading={save.isPending}>
              {t('common.save', { defaultValue: 'Save' })}
            </Button>
          </View>
        </>
      )}
    </Dialog>
  );
}
