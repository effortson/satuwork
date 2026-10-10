import { Redirect } from 'expo-router'
import { useSession } from '@/store'

export default function Index() {
  const { token } = useSession()
  return <Redirect href={token ? '/bots' : '/login'} />
}
