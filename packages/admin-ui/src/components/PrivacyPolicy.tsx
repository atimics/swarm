/**
 * Privacy Policy Page
 * Comprehensive privacy policy based on platform security audit.
 * Contact: privacy@rati.chat
 */

interface PrivacyPolicyProps {
  onClose?: () => void;
}

export function PrivacyPolicy({ onClose }: PrivacyPolicyProps) {
  return (
    <div className="min-h-[100dvh] bg-[var(--color-bg)] text-[var(--color-text)] overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-12">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-3xl font-bold">Privacy Policy</h1>
          {onClose && (
            <button
              onClick={onClose}
              className="text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors text-2xl"
              aria-label="Close"
            >
              ✕
            </button>
          )}
        </div>

        <p className="text-sm text-[var(--color-text-secondary)] mb-8">
          Last updated: {new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
        </p>

        <div className="prose prose-invert max-w-none space-y-8 text-[var(--color-text-secondary)]">
          {/* 1. Overview */}
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text)] mb-3">1. Overview</h2>
            <p>
              Swarm by Rati (&quot;we,&quot; &quot;us,&quot; or &quot;our&quot;) operates the Swarm platform at{' '}
              <strong>swarm.rati.chat</strong>, which lets users create and interact with AI avatars
              on the Solana blockchain. This Privacy Policy explains what data we collect,
              how we use it, who we share it with, and your rights.
            </p>
          </section>

          {/* 2. Data We Collect */}
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text)] mb-3">2. Data We Collect</h2>

            <h3 className="text-lg font-medium text-[var(--color-text)] mt-4 mb-2">
              2.1 Authentication &amp; Identity
            </h3>
            <ul className="list-disc pl-6 space-y-1">
              <li><strong>Wallet addresses</strong> — your Solana public key(s), collected on every login.</li>
              <li><strong>Email addresses</strong> — if you sign in via Privy (email/social) or Crossmint.</li>
              <li><strong>Session metadata</strong> — IP address, User-Agent, and timestamps stored in session records (24-hour TTL).</li>
            </ul>

            <h3 className="text-lg font-medium text-[var(--color-text)] mt-4 mb-2">
              2.2 Conversations &amp; AI Interactions
            </h3>
            <ul className="list-disc pl-6 space-y-1">
              <li><strong>Chat messages</strong> — messages you send to avatars, stored for up to 24 hours (100 messages per conversation).</li>
              <li><strong>Avatar memories</strong> — AI-generated summaries of interactions, retained for 30 days by default (varies by plan).</li>
              <li><strong>System prompts &amp; persona data</strong> — avatar configuration you create or edit.</li>
            </ul>

            <h3 className="text-lg font-medium text-[var(--color-text)] mt-4 mb-2">
              2.3 Blockchain &amp; NFT Data
            </h3>
            <ul className="list-disc pl-6 space-y-1">
              <li><strong>NFT ownership status</strong> — we check whether your wallet holds Orb collection NFTs to determine feature access.</li>
              <li><strong>Generated wallet keypairs</strong> — if an avatar has an auto-generated wallet, the private key is stored encrypted in AWS Secrets Manager (KMS).</li>
            </ul>

            <h3 className="text-lg font-medium text-[var(--color-text)] mt-4 mb-2">
              2.4 Audit &amp; Operational Logs
            </h3>
            <ul className="list-disc pl-6 space-y-1">
              <li><strong>Audit logs</strong> — records of administrative actions, retained for 90 days.</li>
              <li><strong>Application logs</strong> — structured logs in AWS CloudWatch for debugging and monitoring.</li>
            </ul>

            <h3 className="text-lg font-medium text-[var(--color-text)] mt-4 mb-2">
              2.5 Local Storage
            </h3>
            <ul className="list-disc pl-6 space-y-1">
              <li>Authentication state (wallet-auth, privy-auth, crossmint-auth)</li>
              <li>UI preferences (theme, avatar list cache)</li>
              <li>Consent status (this policy acceptance)</li>
            </ul>
          </section>

          {/* 3. How We Use Your Data */}
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text)] mb-3">3. How We Use Your Data</h2>
            <ul className="list-disc pl-6 space-y-1">
              <li>Authenticate your identity and manage sessions.</li>
              <li>Deliver AI avatar conversations and maintain chat context.</li>
              <li>Check NFT ownership for gating features.</li>
              <li>Detect abuse and enforce rate limits.</li>
              <li>Debug issues and improve platform reliability.</li>
            </ul>
          </section>

          {/* 4. Third-Party Data Sharing */}
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text)] mb-3">4. Third-Party Data Sharing</h2>
            <p className="mb-3">
              We share data with the following third-party services as necessary to operate the platform:
            </p>

            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-[var(--color-border)]">
                    <th className="text-left py-2 pr-4 font-medium text-[var(--color-text)]">Provider</th>
                    <th className="text-left py-2 pr-4 font-medium text-[var(--color-text)]">Data Shared</th>
                    <th className="text-left py-2 font-medium text-[var(--color-text)]">Purpose</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border)]">
                  <tr>
                    <td className="py-2 pr-4 font-medium">LLM Providers<br/><span className="text-xs font-normal">(via OpenRouter → Claude, GPT-4)</span></td>
                    <td className="py-2 pr-4">Conversation history (up to 20 messages), system prompts, avatar persona</td>
                    <td className="py-2">AI response generation</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 font-medium">Privy</td>
                    <td className="py-2 pr-4">Access tokens, linked account data</td>
                    <td className="py-2">Email/social authentication</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 font-medium">Crossmint</td>
                    <td className="py-2 pr-4">JWT tokens, user ID, wallet addresses</td>
                    <td className="py-2">Wallet-based authentication</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 font-medium">Helius / Solana RPC</td>
                    <td className="py-2 pr-4">Wallet public keys</td>
                    <td className="py-2">NFT ownership verification</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 font-medium">Replicate</td>
                    <td className="py-2 pr-4">AI model prompts</td>
                    <td className="py-2">Image/video/audio generation</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 font-medium">Telegram / Twitter / Discord APIs</td>
                    <td className="py-2 pr-4">Message content, media</td>
                    <td className="py-2">Channel integrations (if you connect them)</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 font-medium">AWS</td>
                    <td className="py-2 pr-4">All backend data</td>
                    <td className="py-2">Infrastructure (DynamoDB, Lambda, CloudWatch, Secrets Manager)</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          {/* 5. Data Retention */}
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text)] mb-3">5. Data Retention</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-[var(--color-border)]">
                    <th className="text-left py-2 pr-4 font-medium text-[var(--color-text)]">Data Type</th>
                    <th className="text-left py-2 font-medium text-[var(--color-text)]">Retention</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border)]">
                  <tr><td className="py-2 pr-4">Session records</td><td className="py-2">24 hours (auto-deleted)</td></tr>
                  <tr><td className="py-2 pr-4">Chat messages</td><td className="py-2">24 hours (auto-deleted)</td></tr>
                  <tr><td className="py-2 pr-4">Avatar memories</td><td className="py-2">30 days default (plan-dependent)</td></tr>
                  <tr><td className="py-2 pr-4">Audit logs</td><td className="py-2">90 days</td></tr>
                  <tr><td className="py-2 pr-4">Account &amp; identity records</td><td className="py-2">Until account deletion</td></tr>
                  <tr><td className="py-2 pr-4">Application logs (CloudWatch)</td><td className="py-2">Per AWS retention settings</td></tr>
                </tbody>
              </table>
            </div>
          </section>

          {/* 6. Data Security */}
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text)] mb-3">6. Data Security</h2>
            <ul className="list-disc pl-6 space-y-1">
              <li>All data in transit is encrypted via TLS (HTTPS enforced).</li>
              <li>DynamoDB data is encrypted at rest with AES-256.</li>
              <li>Secrets (API keys, wallet private keys) are stored in AWS Secrets Manager with KMS encryption.</li>
              <li>Session cookies use HttpOnly, Secure, and SameSite=Lax flags.</li>
              <li>WAF v2 with IP reputation and rate limiting protects API endpoints.</li>
              <li>CORS is origin-validated; security headers include HSTS, X-Frame-Options, and X-Content-Type-Options.</li>
              <li>Wallet signatures are verified using Ed25519 (SIWS — Sign In With Solana).</li>
            </ul>
          </section>

          {/* 7. Your Rights */}
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text)] mb-3">7. Your Rights</h2>
            <p className="mb-3">You have the right to:</p>
            <ul className="list-disc pl-6 space-y-1">
              <li><strong>Access</strong> — request a copy of the data we hold about you.</li>
              <li><strong>Correction</strong> — request correction of inaccurate data.</li>
              <li><strong>Deletion</strong> — request deletion of your personal data.</li>
              <li><strong>Portability</strong> — request your data in a machine-readable format.</li>
              <li><strong>Withdraw consent</strong> — revoke your consent at any time (this does not affect the lawfulness of prior processing).</li>
            </ul>
            <p className="mt-3">
              To exercise any of these rights, contact us at{' '}
              <a href="mailto:privacy@rati.chat" className="text-brand-400 hover:text-brand-300 underline">
                privacy@rati.chat
              </a>.
            </p>
          </section>

          {/* 8. Cookies & Local Storage */}
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text)] mb-3">8. Cookies &amp; Local Storage</h2>
            <ul className="list-disc pl-6 space-y-1">
              <li>
                <strong>swarm_session</strong> — HttpOnly session cookie (24-hour expiry).
                Required for authentication. No third-party tracking cookies are used.
              </li>
              <li>
                <strong>localStorage</strong> — stores auth state, UI preferences, and consent
                status client-side. You can clear this via browser settings.
              </li>
            </ul>
          </section>

          {/* 9. AI Processing Disclosure */}
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text)] mb-3">9. AI Processing Disclosure</h2>
            <p>
              When you interact with an avatar, your messages (along with recent conversation
              history of up to 20 messages) are sent to third-party AI model providers
              (currently via OpenRouter, which routes to models like Anthropic Claude and
              OpenAI GPT-4) for response generation. These providers may process your data
              according to their own privacy policies. We do not use your conversations to
              train our own models.
            </p>
          </section>

          {/* 10. Children */}
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text)] mb-3">10. Children&apos;s Privacy</h2>
            <p>
              Swarm is not intended for children under 13. We do not knowingly collect data
              from children. If you believe a child has provided us data, please contact us
              at{' '}
              <a href="mailto:privacy@rati.chat" className="text-brand-400 hover:text-brand-300 underline">
                privacy@rati.chat
              </a>.
            </p>
          </section>

          {/* 11. Changes */}
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text)] mb-3">11. Changes to This Policy</h2>
            <p>
              We may update this policy from time to time. If we make material changes,
              we will re-prompt for your consent within the application. The policy version
              is tracked, and you will be notified when acceptance of a new version is required.
            </p>
          </section>

          {/* 12. Contact */}
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text)] mb-3">12. Contact</h2>
            <p>
              For privacy inquiries, data requests, or concerns:
            </p>
            <p className="mt-2 font-medium text-[var(--color-text)]">
              📧{' '}
              <a href="mailto:privacy@rati.chat" className="text-brand-400 hover:text-brand-300 underline">
                privacy@rati.chat
              </a>
            </p>
          </section>
        </div>

        {/* Footer */}
        <div className="mt-12 pt-8 border-t border-[var(--color-border)] text-center text-sm text-[var(--color-text-muted)]">
          <p>Swarm by Rati — Privacy Policy v1.0</p>
        </div>
      </div>
    </div>
  );
}
