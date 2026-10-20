// /api/v1/documents/* (web access, step 4b). The document service makes every check
// (who may upload, see or review; reading, extraction, the review rules); these
// routes only pass it the signed-in user.
//
//   POST /api/v1/documents?fileName=invoice.pdf[&kind=invoice]
//        The body is the file itself (Content-Type application/pdf, application/json
//        or application/octet-stream), up to the service's own size limit.
//        Safe to repeat: the same person uploading the same content gets the same document.
//   GET  /api/v1/documents[?status=flagged_for_review]   the documents this user may see
//   GET  /api/v1/documents/due-for-deletion               past the retention period (reviewers)
//   GET  /api/v1/documents/:documentId                    one document
//   POST /api/v1/documents/:documentId/review             { decision, corrections, kind, note, expectedVersion }
//
// Replies leave out storageRef: where the file is kept is internal.

import { DEFAULT_MAX_BYTES } from '../documents/formats.js';

export const UPLOAD_TYPES = Object.freeze(['application/pdf', 'application/json', 'application/octet-stream']);

const shown = ({ storageRef, ...doc }) => doc;
const optional = (query, name) => query.get(name) ?? undefined;

export function documentRoutes({ documents, maxBytes = DEFAULT_MAX_BYTES }) {
  return [
    {
      method: 'POST', path: '/api/v1/documents', auth: 'session', rawBody: { types: UPLOAD_TYPES, maxBytes },
      handle: async ({ user, bytes, query }) => ({
        body: { document: shown(await documents.uploadDocument({ user, fileName: optional(query, 'fileName'), bytes, kind: optional(query, 'kind') })) },
      }),
    },
    {
      method: 'GET', path: '/api/v1/documents', auth: 'session',
      handle: async ({ user, query }) => ({ body: { documents: (await documents.listDocuments({ user, status: optional(query, 'status') })).map(shown) } }),
    },
    {
      method: 'GET', path: '/api/v1/documents/due-for-deletion', auth: 'session',
      handle: async ({ user }) => ({ body: { documents: (await documents.listDueForDeletion({ user })).map(shown) } }),
    },
    {
      method: 'GET', path: '/api/v1/documents/:documentId', auth: 'session',
      handle: async ({ user, params }) => ({ body: { document: shown(await documents.getDocument({ user, documentId: params.documentId })) } }),
    },
    {
      method: 'POST', path: '/api/v1/documents/:documentId/review', auth: 'session',
      handle: async ({ user, params, body }) => ({
        body: {
          document: shown(await documents.reviewDocument({
            user, documentId: params.documentId, decision: body.decision, corrections: body.corrections ?? {},
            kind: body.kind ?? undefined, note: body.note, expectedVersion: body.expectedVersion,
          })),
        },
      }),
    },
  ];
}
