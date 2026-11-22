import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { createHash } from 'node:crypto';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { verifySync } from 'otplib';
import * as bcrypt from 'bcrypt';
import { User } from '../../users/entities/user.entity';
import { JwtHelper } from '../helper/jwt-helper';
import { VerifyTotpDto } from '../dto/verify-totp.dto';
import { UseBackupCodeDto } from '../dto/use-backup-code.dto';

/**
 * How long a successfully verified TOTP code is remembered (#853).
 *
 * A code is valid for one 30 second step, so 90 seconds comfortably outlives
 * it even if the verifier is later configured to accept a neighbouring step.
 */
export const TOTP_REPLAY_TTL_MS = 90_000;

@Injectable()
export class VerifyTotpProvider {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    private readonly jwtHelper: JwtHelper,
    @Inject(CACHE_MANAGER)
    private readonly cacheManager: Cache,
  ) {}

  /**
   * Cache key for a consumed code. The code is hashed together with the user
   * id so the cache never holds a raw one-time password and one user's code
   * can never block another user's.
   */
  private replayKey(userId: string, token: string): string {
    const digest = createHash('sha256')
      .update(`${userId}:${token}`)
      .digest('hex');
    return `auth:totp:used:${digest}`;
  }

  async verifyTotpLogin(dto: VerifyTotpDto) {
    const payload = this.jwtHelper.verifyTempToken(dto.tempToken);
    const user = await this.usersRepository.findOne({
      where: { id: payload.sub },
    });
    if (!user || !user.totpSecret) {
      throw new UnauthorizedException('User not found or 2FA not set up');
    }

    const result = verifySync({ token: dto.token, secret: user.totpSecret });
    if (!result?.valid) {
      throw new UnauthorizedException('Invalid TOTP code');
    }

    // A correct code can only complete verification once per time window.
    // Only codes that passed verification are remembered, so a mistyped code
    // never blocks the member from entering the right one.
    const replayKey = this.replayKey(user.id, dto.token);
    if (await this.cacheManager.get(replayKey)) {
      throw new UnauthorizedException('TOTP code has already been used');
    }
    await this.cacheManager.set(replayKey, true, TOTP_REPLAY_TTL_MS);

    const tokens = this.jwtHelper.generateTokens(user);
    return {
      user: { id: user.id, email: user.email, role: user.role },
      ...tokens,
    };
  }

  async verifyBackupCode(dto: UseBackupCodeDto) {
    const payload = this.jwtHelper.verifyTempToken(dto.tempToken);
    const user = await this.usersRepository.findOne({
      where: { id: payload.sub },
    });
    if (!user || !user.totpBackupCodes?.length) {
      throw new UnauthorizedException(
        'User not found or no backup codes available',
      );
    }

    let matchedIndex = -1;
    for (let i = 0; i < user.totpBackupCodes.length; i++) {
      const match = await bcrypt.compare(
        dto.backupCode,
        user.totpBackupCodes[i],
      );
      if (match) {
        matchedIndex = i;
        break;
      }
    }

    if (matchedIndex === -1) {
      throw new UnauthorizedException('Invalid backup code');
    }

    // Remove the used code
    user.totpBackupCodes = user.totpBackupCodes.filter(
      (_, i) => i !== matchedIndex,
    );
    await this.usersRepository.save(user);

    const tokens = this.jwtHelper.generateTokens(user);
    return {
      user: { id: user.id, email: user.email, role: user.role },
      ...tokens,
      backupCodesRemaining: user.totpBackupCodes.length,
    };
  }
}
