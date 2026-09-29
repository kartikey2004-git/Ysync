import { NextResponse, type NextRequest } from "next/server";

const PUBLIC_PATHS = ["/", "/auth", "/api"];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isPublic(pathname)) return NextResponse.next();

  const hasSession =
    request.cookies.has("ysync.session_token") ||
    request.cookies.has("__Secure-ysync.session_token");

  if (!hasSession) {
    const signIn = new URL("/auth/signin", request.url);
    signIn.searchParams.set("redirect", pathname);
    return NextResponse.redirect(signIn);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/doc/:path*", "/dashboard"],
};
