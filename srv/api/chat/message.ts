import { assertValid } from 'frisker'
import { store } from '../../db'
import { logger } from '../../logger'
import { createResponseStream } from '../adapter/generate'
import { errors, handle } from '../handle'
import { publishMany } from '../ws/message'
import { obtainLock, releaseLock, verifyLock } from './lock'

export const generateMessage = handle(async ({ userId, params, body, log }, res) => {
  const id = params.id
  assertValid({ message: 'string', history: 'any', ephemeral: 'boolean?', retry: 'boolean?' }, body)

  const lockId = await obtainLock(id)

  const chat = await store.chats.getChat(id)
  if (!chat) {
    throw errors.NotFound
  }

  const members = chat.memberIds.concat(chat.userId)
  if (!members.includes(userId!)) {
    throw errors.Forbidden
  }

  const lockProps = { chatId: id, lockId }

  res.json({ success: true, message: 'Generating message' })
  await verifyLock(lockProps)

  if (!body.retry) {
    const userMsg = await store.chats.createChatMessage({
      chatId: id,
      message: body.message,
      senderId: userId!,
    })
    publishMany(members, { type: 'message-created', msg: userMsg })
  }

  const { stream } = await createResponseStream({
    senderId: userId!,
    chatId: id,
    message: body.message,
    history: body.history,
  })

  let generated = ''

  for await (const gen of stream) {
    log.debug(gen, 'Generated')
    if (typeof gen === 'string') {
      generated = gen
      publishMany(members, { type: 'message-partial', partial: gen, chatId: id })
      continue
    }

    if (gen.error) {
      publishMany(members, { type: 'message-error', error: gen.error, chatId: id })
      continue
    }
  }

  await verifyLock(lockProps)
  const msg = await store.chats.createChatMessage(
    { chatId: id, message: generated, characterId: chat.characterId },
    body.ephemeral
  )

  publishMany(members, { type: 'message-created', msg })
  await releaseLock(id)
})

export const retryMessage = handle(async ({ body, params, userId }, res) => {
  const { id, messageId } = params

  assertValid(
    {
      history: 'any',
      message: 'string',
      ephemeral: 'boolean?',
    },
    body
  )

  const lockId = await obtainLock(id)

  const prev = await store.chats.getMessageAndChat(messageId)
  if (!prev || !prev.chat) throw errors.NotFound

  const members = prev.chat.memberIds.concat(prev.chat.userId)
  if (!members.includes(userId!)) throw errors.Forbidden

  res.json({ success: true, message: 'Re-generating message' })

  await verifyLock({ chatId: id, lockId })

  const { stream } = await createResponseStream({
    chatId: params.id,
    history: body.history,
    message: body.message,
    senderId: userId!,
  })

  const props = { chatId: id, messageId }
  let generated = ''

  for await (const gen of stream) {
    logger.debug(gen, 'Generated')
    if (typeof gen === 'string') {
      generated = gen
      publishMany(members, { type: 'message-partial', partial: gen, ...props })
      continue
    }

    if (gen.error) {
      publishMany(members, { type: 'message-error', error: gen.error, ...props })
    }
  }

  if (!body.ephemeral) {
    await verifyLock({ chatId: id, lockId })
    await store.chats.editMessage(messageId, generated)
  }

  publishMany(members, {
    type: 'message-retry',
    ...props,
    message: generated,
  })

  await releaseLock(id)

  res.end()
})
