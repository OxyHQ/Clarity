import { useCallback, useEffect, useRef } from 'react';
import { useOxy } from '@oxy.so/services/ui/client';

const serviceIds = new WeakMap<object, number>();
let nextServiceId = 0;
const userIds = new Map<string, number>();
let nextUserId = 0;

function userSlot(userId: string | undefined): number {
  if (!userId) return 0;
  let id = userIds.get(userId);
  if (id === undefined) {
    id = ++nextUserId;
    userIds.set(userId, id);
  }
  return id;
}

function serviceId(service: object): number {
  let id = serviceIds.get(service);
  if (id === undefined) {
    id = ++nextServiceId;
    serviceIds.set(service, id);
  }
  return id;
}

/** A render's observed session. It does not establish actor authority. */
export function useBillingSession() {
  const { oxyServices, isAuthenticated, canUsePrivateApi, user } = useOxy();
  const userId = user?.id;
  const latest = useRef({ oxyServices, isAuthenticated, canUsePrivateApi, userId });
  latest.current = { oxyServices, isAuthenticated, canUsePrivateApi, userId };
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const epoch = oxyServices.http.getSessionEpoch();
  const ready = Boolean(
    isAuthenticated && canUsePrivateApi && userId && oxyServices.http.getAccessToken(),
  );
  const isObserved = useCallback(
    () =>
      isAuthenticated &&
      canUsePrivateApi &&
      !!userId &&
      latest.current.isAuthenticated &&
      latest.current.canUsePrivateApi &&
      latest.current.userId === userId &&
      !!oxyServices.http.getAccessToken() &&
      latest.current.oxyServices === oxyServices &&
      oxyServices.http.getSessionEpoch() === epoch,
    [oxyServices, isAuthenticated, canUsePrivateApi, userId, epoch],
  );
  const isCurrent = useCallback(() => mounted.current && isObserved(), [isObserved]);
  return {
    isCurrent,
    isObserved,
    ready,
    cacheKey: [serviceId(oxyServices), userSlot(userId), epoch] as const,
  };
}

export type BillingSessionCheck = () => boolean;

export function requireBillingSession(isCurrent: BillingSessionCheck): void {
  if (typeof isCurrent !== 'function' || !isCurrent()) throw new Error('Billing session changed');
}
