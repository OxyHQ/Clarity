import { checkContract, createOrganizationCheck } from '@oxy.so/contracts/client';
import type { CreateOrganization, OrganizationType } from '@oxy.so/contracts';

/** Normalize an organization draft and validate it with the shared client contract. */
export function parseOrganizationDraft(input: {
  name: string;
  organizationType: OrganizationType;
  websiteUrl: string;
  countryCode: string;
}): CreateOrganization | null {
  return checkContract(createOrganizationCheck, {
    name: input.name.trim(),
    organizationType: input.organizationType,
    websiteUrl: input.websiteUrl.trim() || null,
    countryCode: input.countryCode.trim().toUpperCase() || null,
  });
}
