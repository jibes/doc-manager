import { useLocalSearchParams } from 'expo-router';

import { ReadView } from '@/paper/reader/ReadView';

export default function ReadScreen() {
  const { id, page, q } = useLocalSearchParams<{ id: string; page?: string; q?: string }>();
  return <ReadView id={id} page={page} q={q} />;
}
