import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: Record<string, unknown>) {
    super(message);
  }
}

export const uuid = z.string().uuid();
export const code = z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9-]{2,63}$/);
export const key = z.string().uuid();
export const text = (max: number) => z.string().trim().min(1).max(max);
export const date = z.string().datetime({ offset: true });
export const centimes = z.number().int().min(0).max(1_000_000_000);
export const page = z.coerce.number().int().min(1).max(100_000).default(1);
export const missing = (message = 'Enregistrement introuvable.') => new ApiError(404,'NOT_FOUND',message);
export const forbidden = () => new ApiError(403,'FORBIDDEN','Action non autorisée pour ce compte.');
export const conflict = (code: string, message: string) => new ApiError(409,code,message);

export function param(request: FastifyRequest, name = 'id') {
  return uuid.parse((request.params as Record<string, unknown>)[name]);
}

export function sendFile(reply: FastifyReply, filename: string, mime: string, bytes: Uint8Array) {
  return reply.type(mime).header('Content-Disposition',`attachment; filename="${filename}"`).send(Buffer.from(bytes));
}

const dbErrors: Record<string, [number,string]> = {
  RETURN_BON_NOT_FOUND: [404,'Bon introuvable.'],
  RETURN_BON_CLOSED: [409,'Ce bon est clôturé.'],
  RETURN_BON_LOCKED: [409,'La liste est verrouillée depuis le premier scan.'],
  RETURN_BON_NOT_SENT: [409,'Envoyez le bon et recevez ses colis avant de le clôturer.'],
  RETURN_PARCELS_MISSING: [409,'Il reste des colis attendus.'],
  RETURN_CODE_REMOVED: [409,'Code retiré du Bon — Veuillez actualiser.'],
  RETURN_CODE_INELIGIBLE: [409,'Ce code figure parmi les anomalies du bon.'],
  SCAN_DUPLICATE: [409,'Ce colis a déjà été reçu.'],
  SCAN_UNKNOWN: [404,'Code de suivi inconnu.'],
  SCAN_WRONG_AGENCY: [409,'Le colis est détenu par une autre agence ou a déjà quitté l’agence.'],
  SCAN_WRONG_STATUS: [409,'Le statut de la commande doit être corrigé avant réception.'],
  SCAN_KEY_REUSED: [409,'Cette clé de scan est déjà associée à une autre opération.'],
  SCAN_CONFIRM_MANUAL: [422,'Confirmez la réception sans scan physique.'],
  SCAN_FORBIDDEN: [403,'Ce compte ne peut pas recevoir de colis.'],
  PAID_DOCUMENT_IMMUTABLE: [409,'Un document payé est figé.'],
  'Payment Bon not fully settled': [409,'Le bon doit être intégralement réglé.'],
  'Already paid': [409,'Ce bon est déjà payé.'],
  'Finance approval permission denied': [403,'Confirmation financière non autorisée.'],
};

export function errorReply(error: unknown, reply: FastifyReply) {
  if (error instanceof ApiError) {
    return reply.code(error.status).send({ code:error.code, message:error.message, details:error.details });
  }
  if (error instanceof z.ZodError) {
    return reply.code(422).send({ code:'INVALID_INPUT', message:'Vérifiez les champs du formulaire.',
      fields: error.issues.map(issue => issue.path.join('.')) });
  }
  const err = error as { message?: string; code?: string; statusCode?: number };
  if (err.code === 'P0001' && err.message && Object.hasOwn(dbErrors,err.message)) {
    const [status,message] = dbErrors[err.message];
    return reply.code(status).send({ code:err.message, message });
  }
  if (err.code === '23505') return reply.code(409).send({ code:'ALREADY_EXISTS', message:'Cet enregistrement existe déjà.' });
  if (err.code === '23503' || err.code === '23514') {
    return reply.code(422).send({ code:'INVALID_REFERENCE', message:'Référence ou état incompatible.' });
  }
  if (err.code === '40001' || err.code === '40P01' || err.code === '57014') {
    return reply.code(503).send({ code:'RETRY', message:'Opération temporairement indisponible. Réessayez avec la même clé.' });
  }
  if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
    return reply.code(err.statusCode).send({ code:'REQUEST_REJECTED', message:'La requête a été refusée.' });
  }
  console.error('TransitFlow request failed', { requestId: reply.request.id,
    errorType: error instanceof Error ? error.name : 'Unknown', databaseCode: /^[0-9A-Z]{5}$/.test(err.code ?? '') ? err.code : undefined });
  return reply.code(500).send({ code:'SERVER_ERROR', message:'Erreur serveur. Réessayez.' });
}
