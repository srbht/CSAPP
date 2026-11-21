import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from './api';
import { useAuth } from './auth';
import type { AcademicYear, GradingSystem, Medium, Standard } from './types';

export const useYears = () => useQuery({ queryKey: ['academic-years'], queryFn: () => api.get<AcademicYear[]>('/academic-years'), staleTime: 60_000 });
export const useMediums = () => useQuery({ queryKey: ['mediums'], queryFn: () => api.get<Medium[]>('/mediums'), staleTime: 60_000 });
export const useStandards = () => useQuery({ queryKey: ['standards'], queryFn: () => api.get<Standard[]>('/standards'), staleTime: 60_000 });
export const useGradingSystems = (enabled = true) =>
  useQuery({ queryKey: ['grading-systems'], queryFn: () => api.get<GradingSystem[]>('/grading-systems'), staleTime: 60_000, enabled });

/** The global year / medium chosen in the top bar (stored on the user's profile). */
export function useWorkingContext() {
  const { me } = useAuth();
  const years = useYears();
  const yearId = me?.preferences.academicYearId ?? years.data?.find((y) => y.isCurrent)?.id ?? null;
  return { yearId, mediumId: me?.preferences.mediumId ?? null, year: years.data?.find((y) => y.id === yearId) };
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
