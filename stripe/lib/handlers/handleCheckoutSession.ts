import Stripe from "stripe";
import { getSubscriptionId, SUBCRIPTION_ID_KEY } from "../utils/getSubscriptionId";
import { CtlxClientType } from "@shared-utils/client";
import { HandlerReturn } from "@shared-utils/index";
import { createLicense } from "@shared-utils/licenseActions";
import { insertUser } from "@shared-utils/userActions";

export async function handleCheckoutSessionFlow({ event, productId, client }: { event: Stripe.CheckoutSessionCompletedEvent, productId: string, client: CtlxClientType }): Promise<HandlerReturn> {
    const session = event.data.object;
    const email = session.customer_email ?? session.customer_details?.email;
    const checkoutSessionId = session.id;

    if (!email) {
        throw new Error(`Customer email not found in checkout session ${checkoutSessionId}.`);
    }

    const userName = session.customer_details?.name ?? `Stripe Checkout ${checkoutSessionId}`;

    // 1. Garante que o usuário existe no Cryptlex
    const userId = await insertUser(email, userName, client);
    const subscriptionId = getSubscriptionId(session.subscription);

    const body = {
        productId: productId,
        userId: userId,
        metadata: [
            {
                key: SUBCRIPTION_ID_KEY,
                value: subscriptionId,
                viewPermissions: []
            },
        ]
    };

    // 2. Cria a licença
    const result = await createLicense(client, body);

    // 3. Sincronização com MailerLite (Apenas se a licença foi criada com sucesso)
    if (result.status === 201 && result.data?.license?.key) {
        try {
            const mailerliteApiKey = process.env['MAILERLITE_API_KEY'];
            const mailerliteGroupId = process.env['MAILERLITE_GROUP_ID'];

            if (mailerliteApiKey && mailerliteGroupId) {
                await fetch('https://connect.mailerlite.com/api/subscribers', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                        'Authorization': `Bearer ${mailerliteApiKey}`
                    },
                    body: JSON.stringify({
                        email: email,
                        fields: {
                            name: userName,
                            license_key: result.data.license.key, // Envia a chave 93A67A...
                        },
                        groups: [mailerliteGroupId]
                    })
                });
                console.info(`[MailerLite] Cliente ${email} sincronizado com sucesso.`);
            }
        } catch (error) {
            // Logamos o erro mas não travamos o retorno para o Stripe
            console.error("[MailerLite] Falha na sincronização:", error);
        }
    }

    return result;
}