
import { redis } from "./redis";
export async function checkLimit(user,type){
  const key = `${user}_${type}`;
  let c = await redis.get(key) || 0;
  if(type==="pdf" && c>=5) return false;
  if(type==="chat" && c>=20) return false;
  await redis.set(key, c+1, {ex:86400});
  return true;
}
