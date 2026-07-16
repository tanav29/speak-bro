export type Session = {
id: string
projectID: string
directory: string
parentID?: string
summary?: {
additions: number
deletions: number
files: number
diffs?: Array<FileDiff>
}
share?: {
url: string
}
title: string
version: string
time: {
created: number
updated: number
compacting?: number
}
revert?: {
messageID: string
partID?: string
snapshot?: string
diff?: string
}
}

export type Message = UserMessage | AssistantMessage

export type AssistantMessage = {
id: string
sessionID: string
role: "assistant"
time: {
created: number
completed?: number
}
error?: ProviderAuthError | UnknownError | MessageOutputLengthError | MessageAbortedError | ApiError
parentID: string
modelID: string
providerID: string
mode: string
path: {
cwd: string
root: string
}
summary?: boolean
cost: number
tokens: {
input: number
output: number
reasoning: number
cache: {
read: number
write: number
}
}
finish?: string
}

export type UserMessage = {
id: string
sessionID: string
role: "user"
time: {
created: number
}
summary?: {
title?: string
body?: string
diffs: Array<FileDiff>
}
agent: string
model: {
providerID: string
modelID: string
}
system?: string
tools?: {
[key: string]: boolean
}
}
