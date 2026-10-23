-- Continue with Google keeps the account's profile picture (Google's `picture`, mapped by the user pool).
-- Nullable, no default: existing accounts get theirs at their next Google sign-in.
ALTER TABLE "users" ADD COLUMN "avatar_url" TEXT;
