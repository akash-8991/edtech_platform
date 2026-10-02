import { ArrayMaxSize, IsArray, IsIn, IsISO8601, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto { @IsString() @MinLength(3) @MaxLength(254) email!: string; @IsString() @MinLength(1) @MaxLength(1024) password!: string; }
export class MfaVerifyDto { @IsString() @MaxLength(4096) mfaToken!: string; @IsString() @MinLength(6) @MaxLength(32) code!: string; }
export class CodeDto { @IsString() @MinLength(6) @MaxLength(32) code!: string; }
export class RefreshDto { @IsString() @MaxLength(512) refreshToken!: string; }
export class PasswordChangeDto { @IsString() @MaxLength(1024) current!: string; @IsString() @MinLength(1) @MaxLength(1024) next!: string; }

export class ImportApplicationsDto {
  @IsOptional() @IsString() @MaxLength(2_000_000) csv?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(5000) applications?: any[];
}
export class DecisionDto {
  @IsIn(['APPROVE', 'REJECT', 'RETURN']) decision!: string;
  @IsOptional() @IsString() @MaxLength(2000) reason?: string;
  @IsOptional() @IsISO8601() startAt?: string;
}
