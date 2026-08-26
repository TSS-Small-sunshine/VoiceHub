import { defineEventHandler, getQuery } from 'h3'
import { db, users, songs, songReplayRequests, asc, eq } from '~/drizzle/db'
import { SUBMISSION_NOTE_STATUS } from '~~/server/config/constants'

// 外置 AI 审核网关：按场景拉取待审对象（API Key 鉴权 + ai-review:read）
// 场景：register → 待审核用户；note → 待审公开留言（歌曲 + 重播申请）；song / language → Phase 3 来源同歌曲池
export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const scene = typeof query.scene === 'string' ? query.scene : ''
  const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 50)

  const items: Array<{ id: number; scene: string; payload: Record<string, unknown>; createdAt: string }> = []

  if (scene === 'register') {
    const rows = await db
      .select({
        id: users.id,
        username: users.username,
        name: users.name,
        grade: users.grade,
        class: users.class,
        remark: users.remark,
        createdAt: users.createdAt
      })
      .from(users)
      .where(eq(users.status, 'pending'))
      .orderBy(asc(users.id))
      .limit(limit)
    for (const r of rows) {
      items.push({
        id: r.id,
        scene,
        payload: {
          username: r.username,
          name: r.name,
          grade: r.grade,
          class: r.class,
          remark: r.remark
        },
        createdAt: r.createdAt ? r.createdAt.toISOString() : ''
      })
    }
    return { items }
  }

  if (scene === 'note' || scene === 'song' || scene === 'language') {
    // 歌曲公开留言待审（song / language 场景 Phase 3 期间复用同一池子）
    const songRows = await db
      .select({
        id: songs.id,
        title: songs.title,
        artist: songs.artist,
        submissionNote: songs.submissionNote,
        createdAt: songs.createdAt
      })
      .from(songs)
      .where(eq(songs.submissionNotePublicStatus, SUBMISSION_NOTE_STATUS.PENDING))
      .orderBy(asc(songs.id))
      .limit(limit)

    for (const s of songRows) {
      items.push({
        id: s.id,
        scene: scene === 'language' ? 'language' : scene === 'song' ? 'song' : 'note',
        payload: {
          title: s.title,
          artist: s.artist,
          ...(scene === 'song' ? { remark: s.submissionNote } : scene === 'language' ? { language: null } : { text: s.submissionNote })
        },
        createdAt: s.createdAt ? s.createdAt.toISOString() : ''
      })
    }

    if (scene === 'note') {
      // 重播申请公开留言待审（联表带歌曲归属，供审核上下文）
      const replayRows = await db
        .select({
          id: songReplayRequests.id,
          songId: songReplayRequests.songId,
          submissionNote: songReplayRequests.submissionNote,
          songTitle: songs.title,
          songArtist: songs.artist,
          createdAt: songReplayRequests.createdAt
        })
        .from(songReplayRequests)
        .innerJoin(songs, eq(songReplayRequests.songId, songs.id))
        .where(eq(songReplayRequests.submissionNotePublicStatus, SUBMISSION_NOTE_STATUS.PENDING))
        .orderBy(asc(songReplayRequests.id))
        .limit(limit)

      for (const r of replayRows) {
        items.push({
          id: r.id,
          scene: 'replay_note',
          payload: {
            songId: r.songId,
            title: r.songTitle,
            artist: r.songArtist,
            text: r.submissionNote
          },
          createdAt: r.createdAt ? r.createdAt.toISOString() : ''
        })
      }
    }
  }

  return { items }
})