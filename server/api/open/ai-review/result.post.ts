import { defineEventHandler, readBody } from 'h3'
import { db, users, userStatusLogs, songs, songReplayRequests, and, eq } from '~/drizzle/db'
import { getServerDate } from '~~/server/utils/serverTime'
import { createApiError } from '~~/server/utils/apiError'
import { SERVER_ERROR_CODES, SUBMISSION_NOTE_STATUS } from '~~/server/config/constants'
import { SmtpService } from '~~/server/services/smtpService'

const VALID_DECISIONS = ['APPROVE', 'REJECT', 'REVIEW']
const VALID_SCENES = ['register', 'note', 'replay_note', 'song', 'language']

// 审核通过邮件通知（异步，失败不影响主流程）
async function notifyApproved(name: string | null, email: string) {
  try {
    const smtpService = SmtpService.getInstance()
    if (await smtpService.ensureInitialized()) {
      await smtpService.renderAndSend(email, 'register-approved', {
        title: '注册审核已通过',
        message: `${name ?? ''}，您的注册申请已通过审核，现在可以使用账号登录了。`
      })
    }
  } catch (error) {
    console.error('AI 审核通过邮件发送失败:', error)
  }
}

// 外置 AI 审核网关：写回审核结果（API Key 鉴权 + ai-review:write）
// register：APPROVE → 激活+快照 / REJECT → 删除+快照 / REVIEW → 不动
// note / replay_note：APPROVE → approved+公开 / REJECT → rejected+不公开 / REVIEW → 不动
// song / language：Phase 3 预留，仅确认收到（保持 pending 转人工）
export default defineEventHandler(async (event) => {
  if (!event.context.apiKey) {
    throw createApiError(401, SERVER_ERROR_CODES.AUTH_UNAUTHORIZED, '缺少 API Key 鉴权')
  }

  const body = await readBody(event).catch(() => null)
  const scene = typeof body?.scene === 'string' ? body.scene : ''
  const targetId = Number(body?.targetId)
  const decision = typeof body?.decision === 'string' ? body.decision : ''
  const reason = typeof body?.reason === 'string' && body.reason.trim() ? body.reason.trim() : ''

  if (!VALID_SCENES.includes(scene) || !Number.isInteger(targetId) || targetId <= 0 || !VALID_DECISIONS.includes(decision)) {
    throw createApiError(400, SERVER_ERROR_CODES.COMMON_INVALID_PARAMS, '参数不合法')
  }

  const now = getServerDate()

  if (scene === 'register') {
    if (decision === 'REVIEW') return { success: true, applied: 0 }

    // 快照先行读取：用户被删除后仍可追溯（日志列可空，取不到快照时置空不报错）
    const target = await db
      .select({ username: users.username, name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, targetId))
      .limit(1)
    const targetUser = target[0]

    if (decision === 'APPROVE') {
      // 并发防护：仅当仍处于 pending 时激活，状态变更与快照写入同一事务
      const applied = await db.transaction(async (tx) => {
        const updated = await tx
          .update(users)
          .set({ status: 'active', statusChangedAt: now, statusChangedBy: null })
          .where(and(eq(users.id, targetId), eq(users.status, 'pending')))
          .returning({ id: users.id })
        if (updated.length > 0) {
          await tx.insert(userStatusLogs).values({
            userId: targetId,
            username: targetUser?.username,
            name: targetUser?.name,
            oldStatus: 'pending',
            newStatus: 'active',
            reason: reason || 'AI 初审通过',
            operatorId: null,
            createdAt: now
          })
        }
        return updated.length
      })
      if (applied > 0 && targetUser?.email) {
        notifyApproved(targetUser.name, targetUser.email)
      }
      return { success: true, applied }
    }

    // REJECT：删除 + 快照同一事务，防止删除成功而日志缺失
    const applied = await db.transaction(async (tx) => {
      const deleted = await tx
        .delete(users)
        .where(and(eq(users.id, targetId), eq(users.status, 'pending')))
        .returning({ id: users.id })
      if (deleted.length > 0) {
        await tx.insert(userStatusLogs).values({
          userId: targetId,
          username: targetUser?.username,
          name: targetUser?.name,
          oldStatus: 'pending',
          newStatus: 'rejected',
          reason: reason || 'AI 初审拒绝',
          operatorId: null,
          createdAt: now
        })
      }
      return deleted.length
    })
    return { success: true, applied }
  }

  if (scene === 'note' || scene === 'replay_note') {
    if (decision === 'REVIEW') return { success: true, applied: 0 }

    const status = decision === 'APPROVE' ? SUBMISSION_NOTE_STATUS.APPROVED : SUBMISSION_NOTE_STATUS.REJECTED
    const isApproved = status === SUBMISSION_NOTE_STATUS.APPROVED

    if (scene === 'note') {
      // 并发防护：仅更新仍处于 pending 的留言
      const updated = await db
        .update(songs)
        .set({
          submissionNotePublicStatus: status,
          submissionNotePublic: isApproved
        })
        .where(and(eq(songs.id, targetId), eq(songs.submissionNotePublicStatus, SUBMISSION_NOTE_STATUS.PENDING)))
        .returning({ id: songs.id })
      return { success: true, applied: updated.length }
    }

    // 重播申请公开留言（drizzle 属性为驼峰，列名 submission_note_public_status）
    const updated = await db
      .update(songReplayRequests)
      .set({
        submissionNotePublicStatus: status,
        submissionNotePublic: isApproved
      })
      .where(
        and(
          eq(songReplayRequests.id, targetId),
          eq(songReplayRequests.submissionNotePublicStatus, SUBMISSION_NOTE_STATUS.PENDING)
        )
      )
      .returning({ id: songReplayRequests.id })
    return { success: true, applied: updated.length }
  }

  // song / language：Phase 3 落地状态流转，当前保持 pending 转人工
  return { success: true, note: 'scene 状态流转 Phase 3 落地' }
})