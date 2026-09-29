export class AuthError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "AuthError";
  }
}

export class UnauthenticatedError extends AuthError {
  constructor(message = "authentication required") {
    super("UNAUTHENTICATED", message);
    this.name = "UnauthenticatedError";
  }
}

export class ForbiddenError extends AuthError {
  readonly userId: string;
  readonly documentId: string;
  readonly permission: string;

  constructor(userId: string, documentId: string, permission: string) {
    super("FORBIDDEN", `user ${userId} lacks ${permission} on document ${documentId}`);
    this.name = "ForbiddenError";
    this.userId = userId;
    this.documentId = documentId;
    this.permission = permission;
  }
}

export class DocumentNotFoundError extends AuthError {
  readonly documentId: string;

  constructor(documentId: string) {
    super("DOCUMENT_NOT_FOUND", `document ${documentId} not found`);
    this.name = "DocumentNotFoundError";
    this.documentId = documentId;
  }
}
